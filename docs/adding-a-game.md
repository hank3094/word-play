# Adding a new cooperative game

The lobby, presence, feed, Redis state store, and WebSocket transport are all **game-agnostic**. To
add a game (word search, crossword, bananagrams, …) you implement one backend module and one client
renderer — you don't touch the consumer or `state.py`.

## 1. Backend: a game-type module

Create `games/gametypes/<yourgame>.py` exposing the same pure interface Wordle does (see
`games/gametypes/wordle.py` as the worked example). No Redis, no I/O beyond static data — just
functions over a plain `state` dict:

```python
KEY = "wordsearch"
LABEL = "Word Search"

def create_state() -> dict: ...
    # initial game state (e.g. the grid, the words to find, found list)

def handle_action(state, pid, name, action, data) -> tuple[dict, list[dict]]:
    # validate + apply a move; return (new_state, events).
    # - return the *same* state object + an {"kind": "invalid", "reason": ...} event to reject a move
    #   (only the acting player is told).
    # - emit {"kind": "typing", ...} (or any transient kind) for liveness that shouldn't change state.
    # - emit any other kind to record a durable feed entry.

def is_finished(state) -> bool: ...
def snapshot(state) -> dict: ...      # what clients see — hide anything secret until finished
def result(state) -> dict: ...        # {won, ...} payload saved to the finished-game history
```

Register it in `games/gametypes/__init__.py`:

```python
from . import wordle, wordsearch
GAME_TYPES = {wordle.KEY: wordle, wordsearch.KEY: wordsearch}
```

That's the entire server side. The consumer routes `game_action{gameId, action, data}` to your
`handle_action`; `state.py` persists the new state, appends durable events to the feed, and writes a
`FinishedGame` row when `is_finished` flips true. The lobby's NEW GAME picker reads `game_type_list()`
automatically.

### Conventions

- Keep `handle_action` **pure and deterministic** so it's trivially unit-testable (see
  `games/tests/test_wordle.py`). Put randomness behind a small function (like `pick_word`) you can
  monkeypatch in tests.
- Never expose secrets in `snapshot` until the game is finished.
- Use transient events (no state change) for high-frequency liveness (typing, cursor position) — the
  consumer relays `typing` straight to the game group without a Redis write; mirror that for any
  similar firehose.

## 2. Frontend: a renderer + a view

- Add a `<section id="<yourgame>-game" class="view">` to `frontend/templates/index.html` and a
  `<script>` tag for your module (load order = dependency order).
- Write a controller like `frontend/static/js/wordle.js`: render from each authoritative `game`
  snapshot (`msg.snapshot.board` is your game's view), translate input into
  `Net.send("game_action", {gameId, action, data})`, and handle `feed` events for liveness.
- In `app.js`, the `game` message handler currently assumes Wordle. Branch on
  `snapshot.gameType` to route to the right view + controller.

## 3. Tests

- A `games/tests/test_<yourgame>.py` for the pure rules.
- Extend the e2e flow if the cooperative interaction differs meaningfully from Wordle's.
