"""Authoritative live state for cooperative play, stored in Redis.

This is the cooperative analogue of typing-game's in-memory ``mp_state`` — but backed by Redis so
presence and in-progress games survive a worker reload and could be shared across workers. Two kinds
of state:

* **Presence** — who is currently on the page. ``wp:players`` is a set of connection ids (``pid``);
  ``wp:player:<pid>`` holds the name with a short TTL refreshed on every message (a crash backstop
  so a dropped socket eventually disappears even without a clean disconnect).
* **Games** — ``wp:games`` is a set of active game ids; ``wp:game:<id>`` is a JSON blob
  ``{id, type, status, created, players:{pid:name}, state, feed}`` with a long TTL. ``state`` is the
  game-type's own dict; this module never interprets it — it delegates to the game-type module.

Read-modify-write of a game blob is not atomic across awaits; for the intended cooperative scale
(few players per game) that is acceptable. Tighten with WATCH/MULTI if it ever matters.
"""

from __future__ import annotations

import json
import re
import time
import uuid

from .gametypes import get_game_type
from .redis_client import get_client

PLAYERS_SET = "wp:players"
GAMES_SET = "wp:games"
ACTIVITY_KEY = "wp:activity"
ALIVE_TTL = 45  # seconds; refreshed on every client message / ping
GAME_TTL = 6 * 3600  # abandoned games self-expire after a few hours
FEED_MAX = 30  # keep the last N durable feed events per game
ACTIVITY_MAX = 150  # global activity log entries kept in Redis


def _nkey(pid: str) -> str:
    return f"wp:pname:{pid}"


def _ckey(pid: str) -> str:
    return f"wp:pconn:{pid}"


def _clrkey(pid: str) -> str:
    return f"wp:pcolor:{pid}"


def _gkey(gid: str) -> str:
    return f"wp:game:{gid}"


def _validate_color(color: str) -> str:
    """Accept only #rrggbb hex strings; reject anything else."""
    c = (color or "").strip().lower()
    return c if re.fullmatch(r"#[0-9a-f]{6}", c) else ""


# --- presence --------------------------------------------------------------------------------
# A player is identified by a stable per-browser id (``pid``, persisted in localStorage), NOT by a
# per-connection id. So a refresh — or a second tab — re-uses the same presence slot instead of
# spawning a duplicate. ``wp:pconn:<pid>`` counts live connections for that player; presence (and
# game membership) is only torn down when the count hits zero. A short TTL on both keys is the
# crash backstop: if every connection dies without a clean disconnect, the entry self-heals out of
# the set within ALIVE_TTL.


async def register(pid: str, name: str, color: str = "") -> None:
    r = get_client()
    name = (name or "PLAYER")[:16]
    await r.sadd(PLAYERS_SET, pid)
    await r.set(_nkey(pid), name, ex=ALIVE_TTL)
    await r.set(_clrkey(pid), _validate_color(color), ex=ALIVE_TTL)
    await r.incr(_ckey(pid))
    await r.expire(_ckey(pid), ALIVE_TTL)


async def touch(pid: str) -> None:
    """Refresh a player's liveness TTL (called on every inbound message)."""
    r = get_client()
    if await r.exists(_nkey(pid)):
        await r.expire(_nkey(pid), ALIVE_TTL)
        await r.expire(_ckey(pid), ALIVE_TTL)
        await r.expire(_clrkey(pid), ALIVE_TTL)


async def set_name(pid: str, name: str, color: str | None = None) -> list[str]:
    """Rename (and optionally recolor) a player everywhere. Returns affected game ids."""
    r = get_client()
    name = (name or "PLAYER")[:16]
    await r.set(_nkey(pid), name, ex=ALIVE_TTL)
    if color is not None:
        await r.set(_clrkey(pid), _validate_color(color), ex=ALIVE_TTL)
    await r.sadd(PLAYERS_SET, pid)
    affected = []
    for gid in await r.smembers(GAMES_SET):
        blob = await _load(gid)
        if blob and pid in blob["players"]:
            p = blob["players"][pid]
            new_color = (
                _validate_color(color)
                if color is not None
                else (p.get("color", "") if isinstance(p, dict) else "")
            )
            blob["players"][pid] = {"name": name, "color": new_color}
            await _save(blob)
            affected.append(gid)
    return affected


async def unregister(pid: str) -> list[str]:
    """Drop one connection for a player. Only when the last connection goes does the player leave
    presence and every game (so a refresh / second tab doesn't evict them). Returns affected game
    ids (empty while other connections remain)."""
    r = get_client()
    remaining = await r.decr(_ckey(pid))
    if remaining > 0:
        return []
    await r.srem(PLAYERS_SET, pid)
    await r.delete(_nkey(pid))
    await r.delete(_ckey(pid))
    await r.delete(_clrkey(pid))
    affected = []
    for gid in list(await r.smembers(GAMES_SET)):
        if await leave_game(pid, gid):
            affected.append(gid)
    return affected


async def players_snapshot() -> list[dict]:
    """Everyone currently present; self-heals expired entries out of the set."""
    r = get_client()
    out = []
    for pid in sorted(await r.smembers(PLAYERS_SET)):
        name = await r.get(_nkey(pid))
        if name is None:
            await r.srem(PLAYERS_SET, pid)  # TTL lapsed -> gone
            continue
        color = (await r.get(_clrkey(pid))) or ""
        out.append({"id": pid, "name": name, "color": color})
    return out


# --- games -----------------------------------------------------------------------------------


async def _load(gid: str) -> dict | None:
    raw = await get_client().get(_gkey(gid))
    return json.loads(raw) if raw else None


async def _save(blob: dict) -> None:
    await get_client().set(_gkey(blob["id"]), json.dumps(blob), ex=GAME_TTL)


def validate_new_game(game_type: str, options: dict | None = None) -> str | None:
    """Pre-flight check before creating a game. Returns an error message, or None if it's fine.

    Delegates option validation (e.g. a custom Wordle word) to the game type. Pure/sync so the
    consumer can give the creator immediate feedback without committing anything.
    """
    mod = get_game_type(game_type)
    if mod is None:
        return "Unknown game type."
    validator = getattr(mod, "validate_options", None)
    return validator(options or {}) if validator else None


async def create_game(
    game_type: str,
    pid: str | None = None,
    name: str | None = None,
    options: dict | None = None,
    *,
    color: str | None = None,
) -> str | None:
    mod = get_game_type(game_type)
    if mod is None:
        return None
    r = get_client()
    gid = uuid.uuid4().hex[:8]
    players = (
        {pid: {"name": (name or "PLAYER")[:16], "color": _validate_color(color or "")}}
        if pid
        else {}
    )
    blob = {
        "id": gid,
        "type": game_type,
        "owner": pid,  # the creator; only they may delete the game
        "status": "playing",
        "created": time.time(),
        "players": players,
        "state": mod.create_state(options),
        "feed": [],
    }
    await r.sadd(GAMES_SET, gid)
    await _save(blob)
    return gid


async def join_game(pid: str, gid: str, name: str, *, color: str | None = None) -> dict | None:
    blob = await _load(gid)
    if not blob:
        return None
    blob["players"][pid] = {"name": (name or "PLAYER")[:16], "color": _validate_color(color or "")}
    await _save(blob)
    return _snapshot(blob)


async def leave_game(pid: str, gid: str) -> bool:
    """Remove a player from a game. Deletes the game if it's finished and now empty."""
    blob = await _load(gid)
    if not blob or pid not in blob["players"]:
        return False
    del blob["players"][pid]
    mod = get_game_type(blob["type"])
    if not blob["players"] and mod and mod.is_finished(blob["state"]):
        await _delete(gid)
    else:
        await _save(blob)
    return True


async def delete_game(pid: str, gid: str) -> bool:
    """Delete a game, but only at the request of its owner. Returns True if it was deleted."""
    blob = await _load(gid)
    if not blob or blob.get("owner") != pid:
        return False
    await _delete(gid)
    return True


async def _delete(gid: str) -> None:
    r = get_client()
    await r.srem(GAMES_SET, gid)
    await r.delete(_gkey(gid))


async def apply_action(gid: str, pid: str, name: str, action: str, data: dict) -> dict:
    """Run a game action through the game type.

    Returns ``{"ok", "changed", "events", "finished", "result", "snapshot"}``. ``ok`` is False (and
    ``changed`` False) when the action was rejected — only the acting player should be told. A
    transient ``typing`` action never changes state. When a game finishes, ``result`` carries the
    payload for the SQLite history row.
    """
    blob = await _load(gid)
    mod = get_game_type(blob["type"]) if blob else None
    if not blob or mod is None:
        return {"ok": False, "changed": False, "events": [], "finished": False, "result": None}

    was_finished = mod.is_finished(blob["state"])
    new_state, events = mod.handle_action(blob["state"], pid, name, action, data)
    rejected = any(e.get("kind") == "invalid" for e in events)
    transient = all(e.get("kind") in ("typing",) for e in events)

    if rejected or transient:
        return {
            "ok": not rejected,
            "changed": False,
            "events": events,
            "finished": False,
            "result": None,
        }

    blob["state"] = new_state
    blob["status"] = new_state.get("status", blob["status"])
    durable = [e for e in events if e.get("kind") != "typing"]
    blob["feed"] = (blob["feed"] + durable)[-FEED_MAX:]
    await _save(blob)

    finished_now = mod.is_finished(new_state) and not was_finished
    player_names = [d["name"] if isinstance(d, dict) else d for d in blob["players"].values()]
    return {
        "ok": True,
        "changed": True,
        "events": events,
        "finished": finished_now,
        "result": (mod.result(new_state) | {"players": player_names}) if finished_now else None,
        "snapshot": _snapshot(blob),
    }


def _snapshot(blob: dict) -> dict:
    mod = get_game_type(blob["type"])
    board = mod.snapshot(blob["state"]) if mod else {}
    # Note: ``gameType`` (not ``type``) so spreading a snapshot into a WS message can't clobber the
    # message envelope's ``type`` field. ``board`` is the game-type's own view.
    players = [
        {
            "id": pid,
            "name": d["name"] if isinstance(d, dict) else d,
            "color": d.get("color", "") if isinstance(d, dict) else "",
        }
        for pid, d in blob["players"].items()
    ]
    return {
        "id": blob["id"],
        "gameType": blob["type"],
        "owner": blob.get("owner"),
        "status": blob["status"],
        "players": players,
        "feed": blob["feed"],
        "board": board,
    }


async def game_snapshot(gid: str) -> dict | None:
    blob = await _load(gid)
    return _snapshot(blob) if blob else None


async def list_games() -> list[dict]:
    r = get_client()
    out = []
    for gid in sorted(await r.smembers(GAMES_SET)):
        blob = await _load(gid)
        if not blob:
            await r.srem(GAMES_SET, gid)
            continue
        player_names = [d["name"] if isinstance(d, dict) else d for d in blob["players"].values()]
        out.append(
            {
                "id": blob["id"],
                "gameType": blob["type"],
                "owner": blob.get("owner"),
                "status": blob["status"],
                "count": len(blob["players"]),
                "players": player_names,
            }
        )
    return out


async def lobby_snapshot() -> dict:
    return {"players": await players_snapshot(), "games": await list_games()}


# --- activity log ---------------------------------------------------------------------------


async def push_activity(event: dict) -> None:
    """Prepend an event to the global activity log (newest-first in Redis)."""
    r = get_client()
    stamped = {**event, "ts": time.time()}
    await r.lpush(ACTIVITY_KEY, json.dumps(stamped))
    await r.ltrim(ACTIVITY_KEY, 0, ACTIVITY_MAX - 1)


async def activity_snapshot() -> list[dict]:
    """Return recent activity in chronological (oldest-first) order."""
    r = get_client()
    raw = await r.lrange(ACTIVITY_KEY, 0, -1)
    return [json.loads(e) for e in reversed(raw)]


# --- test helper -----------------------------------------------------------------------------


async def reset() -> None:
    """Flush all wp:* keys (used by tests)."""
    r = get_client()
    keys = await r.keys("wp:*")
    if keys:
        await r.delete(*keys)
