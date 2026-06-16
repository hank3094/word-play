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


@database_sync_to_async
def _save_finished(result: dict, game_type: str) -> None:
    FinishedGame.objects.create(
        game_type=game_type,
        answer=result.get("answer", ""),
        won=bool(result.get("won", False)),
        guesses_used=int(result.get("guesses_used", 0)),
        player_names=",".join(result.get("players", []))[:200],
    )


class PlayConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        # A provisional id until ``hello`` supplies the stable client id; ``registered`` guards
        # teardown so a socket that never said hello doesn't decrement a phantom connection.
        self.pid = uuid.uuid4().hex[:8]
        self.name = "PLAYER"
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
        await S.register(self.pid, self.name)
        self.registered = True
        await self.send_json({"type": "welcome", "id": self.pid, "name": self.name})
        await self._broadcast_lobby()

    async def _set_name(self, content):
        self.name = _clean_name(content.get("name"))
        affected = await S.set_name(self.pid, self.name)
        await self._broadcast_lobby()
        for gid in affected:
            await self._broadcast_game(gid)

    async def _ping(self, content):
        pass  # touch() already refreshed liveness

    async def _create_game(self, content):
        game_type = str(content.get("gameType", "wordle"))
        options = content.get("options") or {}
        error = S.validate_new_game(game_type, options)
        if error:
            await self.send_json({"type": "create_error", "error": error})
            return
        gid = await S.create_game(game_type, self.pid, self.name, options)
        if gid:
            await self._enter_game(gid)

    async def _open_game(self, content):
        gid = str(content.get("gameId", ""))
        if await S.join_game(self.pid, gid, self.name):
            await self._enter_game(gid)

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
            await self.send_json({"type": "rejected", "reason": reason})
            return
        if res["changed"]:
            await self._broadcast_game(gid)
            if res["finished"]:
                await _save_finished(res["result"], res["snapshot"]["gameType"])
                await self._broadcast_lobby()

    # --- broadcast helpers ------------------------------------------------
    async def _broadcast_lobby(self):
        await self.channel_layer.group_send(LOBBY, {"type": "lobby.update"})

    async def _broadcast_game(self, gid):
        await self.channel_layer.group_send(game_group(gid), {"type": "game.update"})

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

    async def game_closed(self, event):
        gid = event["gid"]
        if self.current_game == gid:
            await self.channel_layer.group_discard(game_group(gid), self.channel_name)
            self.current_game = None
            await self.send_json({"type": "game_closed", "gameId": gid})
