# 🟩 WORD PLAY

A web-hosted collection of **cooperative** word games. You set a name, land in a shared **lobby**
where you can see everyone else who's online and every game in progress, and **open a game to play
together**. The first game is **Wordle**, played cooperatively on one shared board — anyone can type
and submit a guess, and everyone watches the letters appear live.

Built with **Django + Channels (ASGI/Daphne)** for realtime WebSockets, **Redis** for live
state/presence (and as the Channels layer), and **SQLite** for a small finished-game history.
The frontend is **vanilla JavaScript** (no build step). The look is deliberately **calm** —
off-white, [OpenDyslexic](https://opendyslexic.org/), no glow or animation noise — and it works on a
**laptop with a keyboard** and a **phone with just a touchscreen**. Deployable with **Docker
Compose**; tested with **pytest** and **Playwright**.

## How it works

- **Set your name** on arrival (stored in your browser; editable from the lobby).
- **Lobby** shows **PLAYERS HERE** (live presence), **GAMES** (every active game, who's in it, and an
  OPEN button), a **+ NEW WORDLE** button, and a **RECENT** history strip.
- **Cooperative Wordle** — one shared 6×5 board per game. Any player in the game can type into the
  current row (on-screen keyboard or a physical one) and press ENTER to submit. Everyone sees the
  same board, the colour feedback (🟩 right spot / 🟨 wrong spot / ⬜ not in word), each other's
  **live typing**, and a feed of guesses. Solve it together in six tries. Guesses that aren't in
  the word list are explained in the feed rather than silently ignored.
- **Random or chosen word** — when you start a Wordle you can let the server pick a random word, or
  **choose the secret word yourself** for your friends to solve. The word is entered password-style
  (masked by default, with a reveal toggle) and must be a real five-letter word.
- **Multiple games at once** — create as many games as you like; they all appear in the lobby for
  anyone to open and join.
- **Cooperative Hangman** — guess a shared secret word one letter at a time. Random words are
  picked by difficulty (easy/medium/hard/nightmare — a hangman-solver simulation, not just raw word
  frequency; see [docs/hangman-difficulty.md](docs/hangman-difficulty.md)), or choose your own word
  (any length, not just five letters). Running out of guesses doesn't end the game — keep guessing,
  or any player can reveal the word.

## Games roadmap

Wordle and Hangman are implemented. The backend (a game-type registry + a generic `game_action`
protocol) and the frontend leave room for more cooperative games — **word search**, **crosswords**,
**bananagrams** — without touching the lobby, presence, feed, or transport. See
[docs/adding-a-game.md](docs/adding-a-game.md).

Features to add:
* Option for lower-case letters (throughout)
* show word stats (popularity in corpus, definition) when prompted

Games to implement:
* secret wordle (it only tells you how many are correct and how many are in the correct position)
* word search (bananagrams style?)
* classic bananagrams
	* will need to be able to view game history, with some diff algorithm so that changes are minimised
* crossword


## Architecture

- **Django + Channels (Daphne ASGI)** — one WebSocket endpoint (`/ws/play/`) drives the lobby and
  every game. See [docs/architecture.md](docs/architecture.md) for the message protocol and Redis
  key schema.
- **Redis** is the authoritative store for **live state** (presence + active games + in-progress
  boards) and the **Channels layer**. **SQLite** persists only **finished games** for the history.
- **Calm, responsive UI** — a single fixed card on desktop, full-screen on phones; an always-present
  on-screen keyboard is the primary input on touch, with a physical-keyboard handler for laptops.

## Quick start (local dev)

```bash
uv sync                                  # install Python deps
uv run playwright install chromium       # browser for e2e tests
docker run -p 6379:6379 -d redis:7-alpine  # a Redis for live state (or: brew services start redis)
uv run python manage.py migrate          # creates the SQLite history db
uv run python manage.py runserver        # http://localhost:8000
```

No Redis handy? Run with the in-process fakeredis + in-memory channel layer (single worker only):

```bash
WORD_PLAY_FAKE_REDIS=1 WORD_PLAY_CHANNEL_LAYER=memory uv run python manage.py runserver
```

## Run with Docker Compose

```bash
docker compose up --build            # serves on http://localhost:8000
```

Two services come up: **redis** (live state + Channels layer) and **app** (Daphne serving HTTP +
WebSockets, static via WhiteNoise, SQLite on a named volume). Point multiple devices on the same
network/VPN at the host to play together. `ALLOWED_HOSTS` defaults to `*` and WS origin checking is
off, so it works behind a VPN.

> Run a **single `app` replica**: game rooms aren't sharded across workers. `channels_redis` is what
> would make horizontal scaling possible later (it would also need room affinity/sharding).

## Tests

```bash
uv run pytest                                   # backend: wordle rules, Redis state, WS consumer, API
uv run pytest tests_e2e --browser chromium      # Playwright: two-client cooperative scenario
```

Tests use fakeredis + the in-memory channel layer (see `wordplay/settings_test.py` and the e2e
`conftest.py`), so **no external Redis is required to run them**.

## Dev tooling

```bash
uv run pre-commit install        # install git hooks
uv run pre-commit run --all-files
```

pytest is kept out of pre-commit to keep commits fast; run it manually or in CI.
