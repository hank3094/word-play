# Architecture

WORD PLAY is a Django + Channels (ASGI/Daphne) app. One WebSocket endpoint drives everything; Redis
holds the live state; SQLite keeps a small finished-game history.

## Processes & data

```
browser ──HTTP──> Django (SPA shell + tiny JSON API)
   │
   └──WebSocket /ws/play/──> PlayConsumer ──> games/state.py ──> Redis (live state)
                                  │                              (also the Channels layer)
                                  └── on finish ──> SQLite (FinishedGame history)
```

- **Live state** (presence, active games, in-progress boards) lives in **Redis**, behind the async
  API in `games/state.py`. It is the cooperative analogue of typing-game's in-memory `mp_state`, but
  Redis-backed so it survives a reload and could be shared by multiple workers.
- **Channels layer** is `channels_redis` in production; the in-memory layer in tests/e2e.
- **SQLite** stores only **finished games** (`games/models.py: FinishedGame`).

### Redis keys (prefix `wp:`)

| Key | Type | Meaning |
|-----|------|---------|
| `wp:players` | set | connection ids (`pid`) currently present |
| `wp:player:<pid>` | string (TTL ~45s) | a player's name; TTL refreshed on every message/ping (crash backstop) |
| `wp:games` | set | active game ids |
| `wp:game:<id>` | string JSON (TTL ~6h) | `{id, type, status, created, players:{pid:name}, state, feed}` |

`state` is the game-type's own dict; `state.py` never interprets it (it delegates to the game-type
module). Read-modify-write of a game blob isn't atomic across awaits — fine for the cooperative scale
(few players per game); tighten with WATCH/MULTI if needed.

## WebSocket protocol (`/ws/play/`, JSON `{"type": ...}`)

**Client → server**

| type | payload | effect |
|------|---------|--------|
| `hello` | `{name}` | register presence, join the lobby |
| `set_name` | `{name}` | rename everywhere |
| `ping` | — | refresh presence TTL |
| `create_game` | `{gameType}` | make a game (you become its owner) and enter it |
| `open_game` | `{gameId}` | join + enter a game |
| `leave_game` | — | leave the current game |
| `delete_game` | `{gameId}` | delete a game — **owner only**; members are bounced to the lobby |
| `game_action` | `{gameId, action, data}` | a move (Wordle: `action` ∈ `typing` \| `guess`) |

**Server → client**

| type | payload |
|------|---------|
| `welcome` | `{id, name}` |
| `lobby` | `{players:[{id,name}], games:[{id,gameType,status,count,players}]}` |
| `game` | `{snapshot:{id,gameType,status,players,feed,board}}` |
| `feed` | `{event}` — transient, currently `{kind:"typing", pid, name, text}` |
| `rejected` | `{reason}` — an invalid move, sent only to the actor |
| `left` | — |
| `game_closed` | `{gameId}` — the owner deleted a game you were in; return to the lobby |

The lobby/game snapshots carry an `owner` (the creator's id), so the client shows a delete control
only to the owner.

### Two-tier broadcast

State changes don't push snapshots to a group directly. The consumer mutates Redis, then
`group_send`s a lightweight signal (`lobby.update` / `game.update`); each socket's handler rebuilds
and sends **its own** snapshot. This keeps every recipient's view correct (e.g. only the answer is
revealed once finished). The one exception is **live typing**, relayed straight to the game group
without touching Redis (one Redis write per keystroke would be wasteful, and the payload is identical
for everyone).

## Test escape hatches

- `WORD_PLAY_FAKE_REDIS=1` → `games/redis_client.py` uses `fakeredis.aioredis` instead of a real
  Redis.
- `WORD_PLAY_CHANNEL_LAYER=memory` → the in-memory Channels layer (single in-process worker).

`wordplay/settings_test.py` forces both (so unit/consumer tests need no external services regardless
of env load order); the Playwright `conftest.py` sets the env vars for its throwaway `runserver`.
