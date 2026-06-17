"""WebSocket consumer for cooperative word games.

One connection per client. Every client joins the ``lobby`` group (presence + active games). When a
client opens a game it also joins that game's ``game_<id>`` group, which carries the shared board,
the live feed, and other players' typing.

Message protocol (JSON, ``{"type": ...}``):

  client -> server: hello{name}, set_name{name}, ping, create_game{gameType, options?},
                    open_game{gameId}, leave_game, delete_game{gameId} (owner only),
                    game_action{gameId, action, data}
  server -> client: welcome{id,name}, lobby{players,games}, game{snapshot}, feed{event},
                    rejected{reason}, create_error{error}, left, game_closed{gameId}

Broadcasts use the two-tier pattern: mutate Redis, then send a lightweight signal to the group;
each socket's handler rebuilds and sends its own snapshot. Live typing is the one exception — it is
relayed straight to the game group without touching Redis (one event per keystroke would be wasteful
and the payload is identical for everyone).
"""

from __future__ import annotations

import re
import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from . import state as S
from .models import FinishedGame

LOBBY = "lobby"


def game_group(gid: str) -> str:
    return f"game_{gid}"


def _clean_name(value) -> str:
    return (str(value or "PLAYER").strip().upper() or "PLAYER")[:16]


def _clean_color(value) -> str:
    c = (str(value or "")).strip().lower()
    return c if re.fullmatch(r"#[0-9a-f]{6}", c) else ""


@database_sync_to_async
def _save_finished(result: dict, game_type: str, gid: str, snapshot: dict) -> None:
    FinishedGame.objects.create(
        game_id=gid,
        game_type=game_type,
        answer=result.get("answer", ""),
        won=bool(result.get("won", False)),
        guesses_used=int(result.get("guesses_used", 0)),
        player_names=",".join(result.get("players", []))[:200],
        snapshot=snapshot,
    )


class PlayConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        # A provisional id until ``hello`` supplies the stable client id; ``registered`` guards
        # teardown so a socket that never said hello doesn't decrement a phantom connection.
        self.pid = uuid.uuid4().hex[:8]
        self.name = "PLAYER"
        self.color = ""
        self.registered = False
        self.current_game: str | None = None
        await self.accept()
        await self.channel_layer.group_add(LOBBY, self.channel_name)

    async def disconnect(self, code):
        await self.channel_layer.group_discard(LOBBY, self.channel_name)
        if self.current_game:
            await self.channel_layer.group_discard(game_group(self.current_game), self.channel_name)
        if not self.registered:
            return
        affected = await S.unregister(self.pid)
        for gid in affected:
            await self._broadcast_game(gid)
        await self._broadcast_lobby()

    # --- dispatch ---------------------------------------------------------
    async def receive_json(self, content, **kwargs):
        await S.touch(self.pid)  # refresh liveness on any inbound message
        handler = {
            "hello": self._hello,
            "set_name": self._set_name,
            "ping": self._ping,
            "create_game": self._create_game,
            "open_game": self._open_game,
            "leave_game": self._leave_game,
            "delete_game": self._delete_game,
            "game_action": self._game_action,
            "fetch_activity": self._fetch_activity,
            "share_start": self._share_start,
            "share_stop": self._share_stop,
            "set_allow_sharing": self._set_allow_sharing,
        }.get(content.get("type"))
        if handler:
            await handler(content)

    # --- client messages --------------------------------------------------
    async def _hello(self, content):
        # Adopt the stable per-browser id so a refresh / second tab is the *same* player.
        cid = str(content.get("cid") or "").strip()[:32]
        if cid:
            self.pid = cid
        self.name = _clean_name(content.get("name"))
        self.color = _clean_color(content.get("color"))
        await S.register(self.pid, self.name, self.color)
        self.registered = True
        await self.send_json({"type": "welcome", "id": self.pid, "name": self.name})
        await self._broadcast_lobby()
        events, has_more = await S.activity_snapshot()
        await self.send_json(
            {"type": "activity_log", "events": events, "offset": 0, "hasMore": has_more}
        )

    async def _set_name(self, content):
        old_name = self.name
        old_color = self.color
        self.name = _clean_name(content.get("name"))
        if "color" in content:
            self.color = _clean_color(content.get("color"))
        name_changed = self.name != old_name
        color_changed = self.color != old_color
        if name_changed or color_changed:
            ev: dict = {
                "kind": "player_updated",
                "name": self.name,
                "color": self.color,
            }
            if name_changed:
                ev["oldName"] = old_name
            if color_changed:
                ev["oldColor"] = old_color
            await self._broadcast_activity(ev)
        affected = await S.set_name(self.pid, self.name, self.color)
        await self._broadcast_lobby()
        for gid in affected:
            await self._broadcast_game(gid)

    async def _ping(self, content):
        pass  # touch() already refreshed liveness

    async def _fetch_activity(self, content):
        offset = max(0, int(content.get("offset") or 0))
        events, has_more = await S.activity_snapshot(offset=offset)
        await self.send_json(
            {"type": "activity_log", "events": events, "offset": offset, "hasMore": has_more}
        )

    # --- live-typing screen sharing (low-frequency: mutate Redis, then broadcast a snapshot) ---
    async def _share_start(self, content):
        gid = str(content.get("gameId", ""))
        if gid == self.current_game and await S.share_start(self.pid, gid):
            await self._broadcast_game(gid)

    async def _share_stop(self, content):
        gid = str(content.get("gameId", ""))
        if gid == self.current_game and await S.share_stop(self.pid, gid):
            await self._broadcast_game(gid)

    async def _set_allow_sharing(self, content):
        gid = str(content.get("gameId", ""))
        if gid == self.current_game and await S.set_allow_sharing(
            self.pid, gid, bool(content.get("allowed"))
        ):
            await self._broadcast_game(gid)

    async def _create_game(self, content):
        game_type = str(content.get("gameType", "wordle"))
        options = content.get("options") or {}
        error = S.validate_new_game(game_type, options)
        if error:
            await self.send_json({"type": "create_error", "error": error})
            return
        gid = await S.create_game(game_type, self.pid, self.name, options, color=self.color)
        if gid:
            await self._broadcast_activity(
                {
                    "kind": "game_created",
                    "gameId": gid,
                    "gameType": game_type,
                    "name": self.name,
                    "color": self.color,
                }
            )
            await self._enter_game(gid)

    async def _open_game(self, content):
        gid = str(content.get("gameId", ""))
        snap = await S.join_game(self.pid, gid, self.name, color=self.color)
        if snap:
            await self._enter_game(gid)
            return
        # Game not in Redis — check if it was saved as a finished game.
        archived = await S.get_finished_snapshot(gid)
        if archived:
            await self._do_leave()  # cleanly exit any current live game
            await self.send_json({"type": "game", "snapshot": archived})

    async def _enter_game(self, gid):
        if self.current_game and self.current_game != gid:
            await self._do_leave()
        self.current_game = gid
        await self.channel_layer.group_add(game_group(gid), self.channel_name)
        await self._broadcast_game(gid)  # includes this socket, so the opener gets the snapshot
        await self._broadcast_lobby()

    async def _leave_game(self, content):
        await self._do_leave()
        await self.send_json({"type": "left"})
        await self._broadcast_lobby()

    async def _do_leave(self):
        gid = self.current_game
        if not gid:
            return
        await S.leave_game(self.pid, gid)
        await self.channel_layer.group_discard(game_group(gid), self.channel_name)
        self.current_game = None
        await self._broadcast_game(gid)

    async def _delete_game(self, content):
        gid = str(content.get("gameId", ""))
        if await S.delete_game(self.pid, gid):
            # Tell everyone in the game it's gone (they get bounced to the lobby), then refresh
            # the lobby list for everyone.
            await self.channel_layer.group_send(
                game_group(gid), {"type": "game.closed", "gid": gid}
            )
            await self._broadcast_lobby()

    async def _game_action(self, content):
        gid = str(content.get("gameId", ""))
        if gid != self.current_game:
            return
        action = str(content.get("action", ""))
        data = content.get("data") or {}

        # Live typing bypasses Redis: relay it straight to the rest of the game group.
        if action == "typing":
            text = str(data.get("text", ""))[:8]
            await self.channel_layer.group_send(
                game_group(gid),
                {
                    "type": "game.feed",
                    "event": {"kind": "typing", "pid": self.pid, "name": self.name, "text": text},
                },
            )
            return

        res = await S.apply_action(gid, self.pid, self.name, action, data)
        if not res["ok"]:
            reason = next(
                (e.get("reason") for e in res["events"] if e.get("kind") == "invalid"), "invalid"
            )
            word = str(data.get("word", "")).lower().strip()
            await self._broadcast_activity(
                {
                    "kind": "rejected",
                    "gameId": gid,
                    "name": self.name,
                    "word": word,
                    "reason": reason,
                    "color": self.color,
                }
            )
            await self.send_json({"type": "rejected", "reason": reason})
            return
        if res["changed"]:
            # Build activity events from the game-type events returned by apply_action.
            evs = res["events"]
            guess_ev = next((e for e in evs if e.get("kind") == "guess"), None)
            win_ev = next((e for e in evs if e.get("kind") == "win"), None)
            lose_ev = next((e for e in evs if e.get("kind") == "lose"), None)
            if guess_ev:
                if win_ev:
                    await self._broadcast_activity(
                        {
                            "kind": "game_won",
                            "gameId": gid,
                            "name": self.name,
                            "word": guess_ev["word"],
                            "marks": guess_ev["marks"],
                            "color": self.color,
                        }
                    )
                else:
                    await self._broadcast_activity(
                        {
                            "kind": "guess",
                            "gameId": gid,
                            "name": self.name,
                            "word": guess_ev["word"],
                            "marks": guess_ev["marks"],
                            "color": self.color,
                        }
                    )
            if lose_ev:
                await self._broadcast_activity(
                    {"kind": "game_lost", "gameId": gid, "answer": lose_ev["answer"]}
                )
            await self._broadcast_game(gid)
            if res["finished"]:
                await _save_finished(
                    res["result"], res["snapshot"]["gameType"], gid, res["snapshot"]
                )
                await self._broadcast_lobby()

    # --- broadcast helpers ------------------------------------------------
    async def _broadcast_lobby(self):
        await self.channel_layer.group_send(LOBBY, {"type": "lobby.update"})

    async def _broadcast_game(self, gid):
        await self.channel_layer.group_send(game_group(gid), {"type": "game.update"})

    async def _broadcast_activity(self, event: dict) -> None:
        stamped = await S.push_activity(event)
        await self.channel_layer.group_send(LOBBY, {"type": "activity.push", "event": stamped})

    # --- group event handlers (server -> this socket) ---------------------
    async def lobby_update(self, event):
        snap = await S.lobby_snapshot()
        await self.send_json({"type": "lobby", **snap})

    async def game_update(self, event):
        if self.current_game:
            snap = await S.game_snapshot(self.current_game)
            if snap:
                await self.send_json({"type": "game", "snapshot": snap})

    async def game_feed(self, event):
        ev = event["event"]
        if ev.get("pid") == self.pid:  # don't echo a player's own typing back to them
            return
        await self.send_json({"type": "feed", "event": ev})

    async def activity_push(self, event):
        await self.send_json({"type": "activity_event", "event": event["event"]})

    async def game_closed(self, event):
        gid = event["gid"]
        if self.current_game == gid:
            await self.channel_layer.group_discard(game_group(gid), self.channel_name)
            self.current_game = None
            await self.send_json({"type": "game_closed", "gameId": gid})
