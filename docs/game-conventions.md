# Game conventions

A reference for an agent adding a new cooperative game to WORD PLAY. It exists to make sure a new
game doesn't miss a component or drift from how the three existing games (`wordle`, `hangman`,
`wordladder`) do things. Read this *and* the matching module in `games/gametypes/` before writing
code — every rule below is illustrated by at least one of them.

See also: `docs/architecture.md` (system-wide: processes, Redis keys, WS protocol, two-tier
broadcast) and `docs/adding-a-game.md` (the short version of this doc). This file is the deeper,
checklist-shaped version of the same interface.

## 1. Mental model

- **One game-type module** = pure functions over a plain `dict`. No Redis, no async, no I/O beyond
  static word lists. This is what makes `games/tests/test_<game>.py` trivial: call the functions
  directly, no server, no fakes.
- **`games/state.py` and `games/consumers.py` never special-case a game type.** They call
  `create_state`, `handle_action`, `snapshot`, `is_finished`, `result` through the registry in
  `games/gametypes/__init__.py` and otherwise treat `state` as an opaque blob. If you find yourself
  wanting to add an `if game_type == "yourgame"` outside your own module, stop — the interface is
  missing something, not your game.
- **The board is shared OR per-player, your choice** — Wordle/Hangman keep one board for the whole
  game; Word Ladder gives each player their own (`state["boards"][pid]`), generated lazily on first
  action. Either is fine; `snapshot()` decides what the client sees either way.
- **Secrets stay server-side until the game is finished.** Wordle/Hangman hide the answer in
  `snapshot()` until `is_finished(state)`; Word Ladder has no secret (`start`/`end` are shown
  immediately) but still gates the *solution path* behind a one-way `reveal_solution` flag.

## 2. Backend: the gametype module interface

Create `games/gametypes/<yourgame>.py`. Required surface (mirror `wordle.py` if unsure):

| Name | Signature | Purpose |
|---|---|---|
| `KEY` | `str` | Registry key, used in messages/URLs (e.g. `"wordsearch"`). |
| `LABEL` | `str` | Display name for the lobby's NEW GAME picker. |
| `create_state(options)` | `dict \| None -> dict` | Build the initial state dict from create-game options. |
| `validate_options(options)` | `dict -> str \| None` | Pre-flight check before a game is created; returns an error string or `None`. Optional but expected — `state.validate_new_game` calls it via `getattr(..., None)` if present. |
| `handle_action(state, pid, name, action, data)` | `-> (dict, list[dict])` | Apply one player action. Returns `(new_state, events)`. |
| `is_finished(state)` | `dict -> bool` | Whether the game has reached an end state. |
| `snapshot(state)` | `dict -> dict` | The client-facing view — secrets hidden until finished. |
| `result(state)` | `dict -> dict` | `{"won": bool, "answer": ..., "guesses_used": int}` saved to `FinishedGame` history. |

Register it in `games/gametypes/__init__.py`:

```python
from . import wordle, hangman, wordladder, yourgame
GAME_TYPES = {wordle.KEY: wordle, hangman.KEY: hangman, wordladder.KEY: wordladder, yourgame.KEY: yourgame}
```

That's the entire server-side wiring — the consumer, Redis store, lobby picker, and history all
pick it up automatically through this registry.

### `create_state(options)`

- Accepts the raw `options` dict from `create_game` (or `None`) — never trust it. Every option has
  a `_clean_*`-style coercion (see `wordladder._clean_length`, `hangman._clean_difficulty`):
  try/except on numeric fields, falling back to a module-level default; membership-check enums
  against a fixed tuple/frozenset, falling back to a default.
  - **ponytail: this duplicates the same try/except-then-fallback shape across modules** — pull
    into a shared `clean_int`/`clean_enum` helper if a fourth game repeats it verbatim.
- Store any value that affects rules later (word length, difficulty, max guesses) **on the state
  dict itself**, not just as a module constant — `wordle.py`'s `word_length`/`max_guesses` are kept
  on `state` so each game is self-describing even if module defaults change later. Module constants
  are fallbacks for state predating a change, not the source of truth.
- A custom/user-supplied value (Wordle's `word`, Hangman's `word`) is validated and used if valid,
  otherwise a random one is picked — `create_state` never errors; `validate_options` is what gives
  the creator feedback before the game exists.
- Expensive generation (Word Ladder's BFS rejection sampling) belongs in `create_state`, not
  `validate_options` — validation should stay cheap/structural since it runs synchronously on every
  create attempt.

### `validate_options(options)`

Cheap, synchronous, structural checks only (type, range, membership) — called by
`state.validate_new_game` *before* `create_game`, so the creator gets immediate feedback without
committing anything to Redis. Returns a human-readable error string, or `None` if the options are
fine. Do not duplicate full game-logic validation here (e.g. don't re-check word-list membership if
that's already cheap and done in `create_state`'s fallback path) — only block what would otherwise
produce a broken game.

### `handle_action(state, pid, name, action, data)`

This is where almost all per-game logic lives. Conventions, derived from all three modules:

1. **Pure and deterministic.** No `random`, no I/O, no clock reads inside the function itself.
   Put randomness behind a small seam (`pick_word`) that tests can monkeypatch — never call it from
   inside `handle_action`.
2. **Return `(state, [...])` unchanged (same object, no copy) to reject a move.** Emit
   `{"kind": "invalid", "reason": "..."}`. The consumer relays this only to the acting player via a
   `rejected` message — nobody else's view changes. Use short, stable `reason` strings (`"length"`,
   `"finished"`, `"unknown_action"`, `"bad_index"`) — the frontend switches on them to render
   specific copy (see `wordle.js: rejectText`).
3. **Check `is_finished(state)` early and reject with `reason: "finished"`** before any other
   validation, *unless* the action is allowed post-finish on purpose (Word Ladder's
   `reveal_solution`, Hangman's `reveal` after `lost`) — those get their own branch ahead of the
   finished-guard.
4. **Transient (no state change) actions get their own event kind and are never persisted.**
   `"typing"` is the standing example — `state.apply_action` treats any event set that's entirely
   `{"typing", "duplicate"}` as `transient` and skips the Redis write. If you add another
   high-frequency, no-state-change action (cursor position, presence ping), reuse this pattern
   rather than writing state every time.
5. **Idempotent retries via `requestId` if a move can plausibly be resent.** Wordle's `guess` stores
   `{"pid", "requestId"}` of the last applied guess on the state and, if a resend matches, returns
   the *unchanged* state plus `{"kind": "duplicate"}` instead of double-applying it. This exists
   because of the websocket retry path (§5) — a client may legitimately resend the exact same
   action after a stalled/zombie connection forces a reconnect. **Any action whose effect is hard to
   undo or whose double-application would be visibly wrong (a guess, a step, a reveal) should
   support this.** A `set_word`-style action that's naturally idempotent (last write wins, like Word
   Ladder's) doesn't need it.
6. **A guess/move that's invalid as *content* (not a real word, not a valid edit) doesn't have to be
   rejected at the protocol level.** Word Ladder stores invalid words as-is and flags them in
   `snapshot` (`isWord`, `isValidEdit`) rather than bouncing them — appropriate when the UI shows the
   problem inline (e.g. a red row) instead of needing a `rejected` toast. Choose per game: Wordle
   rejects (no partial board state makes sense for "not a word"); Word Ladder accepts and flags
   (the player can see and fix their own row).
7. **Events**: return a list, not a single dict, even when there's normally one. A single action can
   produce a routine event *and* a finishing event together — e.g. Wordle's `guess` plus `win`,
   Hangman's `guess_letter` plus `win`/`lose`. The consumer (`consumers.py: _game_action`) looks for
   specific `kind`s via `next((e for e in evs if e.get("kind") == "...") , None)` to build the
   activity-feed entry — so:
   - Reuse `"win"` / `"lose"` / `"revealed"` kinds across game types (the consumer builds their
     activity payload generically via `.get()`, not direct indexing).
   - Give your *routine* per-move event its own distinct `kind` if its payload shape differs from
     existing ones (Hangman's `"letter_guess"` is deliberately not `"guess"` because the consumer's
     `"guess"` handling assumes Wordle's `word` + `marks` shape). If you add a new routine kind, also
     add a branch for it in `consumers.py: _game_action` (see `ladder_ev` for the precedent) and in
     `activity.js`/whatever renders the activity feed.
   - `"lose"` should fire **once**, on the transition into the losing state, not on every subsequent
     action while still lost (see Hangman's `old_status != LOST` guard) — otherwise the activity feed
     gets spammed.
8. **A finishing status is not necessarily a terminal one.** Hangman's `"lost"` is *not* in
   `is_finished` — players may keep guessing after the gallows fills, or actively choose to `reveal`.
   Don't assume "lost" == "game over"; check what `is_finished` actually returns for your statuses
   and make sure `snapshot()`'s secret-hiding logic matches it exactly (see next section).

### `snapshot(state)`

- Returns the **client-facing** view. Field names are camelCase (the wire format), even though
  Python state uses snake_case — `word_length` → `wordLength`, `wrong_letters` → `wrongLetters`.
  Translate at this boundary; don't leak snake_case onto the wire.
- Hide secrets with `value if is_finished(state) else None` (or an equivalent masking, like
  Hangman's per-letter mask) — compute `finished = is_finished(state)` once at the top and reuse it,
  don't call `is_finished` separately for each field (drift risk if the statuses ever diverge).
- Include enough self-describing fields that the frontend never needs a second source of truth —
  Wordle's `wordLength`/`maxGuesses` ride along in the snapshot rather than requiring the client to
  know the rules.
- `state.py: _snapshot` wraps your `snapshot()` output as `"board"` inside the outer envelope
  (`{id, gameType, owner, status, players, feed, board, allowSharing, sharers}`) — your module only
  ever returns the inner `board` shape, never the envelope.

### `result(state)`

Always exactly `{"won": bool, "answer": <str, human-readable>, "guesses_used": int}` — this is
persisted verbatim (plus `players`, added by `state.apply_action`) to `FinishedGame`. `answer` is a
display string, not necessarily the raw state field — Word Ladder formats it as
`f"{start} → {end}"` rather than exposing its `solution` list. Keep it short:
`FinishedGame.answer` is a 32-char `CharField` (see Hangman's `MAX_WORD_LEN` comment, sized to fit
under it).

## 3. Word sources, difficulty, and solver-assisted generation

Every game's words come from `games/wordlists.py`, which loads flat text files under
`games/words/` (one file per length/tier, generated offline — see `scripts/generate_wordlists.py`,
`scripts/compute_hangman_difficulty.py`, `scripts/compute_word_ladder_graph.py`). **Never embed a
word list or a frequency call in a gametype module** — add a loader function to `wordlists.py`
(cached with `@cache`, same pattern as `answers()`/`hangman_words()`/`ladder_words()`) and a
generation script if the list needs precomputing.

- **Plain pool, no difficulty**: if your game doesn't need difficulty tiers, a single
  `@cache`-decorated loader returning a `frozenset`/tuple is enough (Wordle's `answers(word_length)`
  — one pool per length, no tiering).
- **Difficulty as a pre-binned pool**: Hangman and Word Ladder both express difficulty as a
  precomputed split into `("easy", "medium", "hard", "nightmare")` tiers, shipped as separate word
  files (`hangman_<difficulty>.txt`, `ladder_<len>_<tier>.txt`) — at request time, `create_state`
  just picks from the tier the player asked for (`hangman.pick_word`) or unions every tier up to a
  ceiling (`wordladder._pool`). The *runtime* code never computes difficulty; it only consumes
  already-binned files. Compute new bins offline, not in the request path.
- **Where a difficulty score comes from**: two different axes are in use, pick whichever fits the
  game's actual source of difficulty:
  - *Obscurity* — `wordfreq`'s English zipf frequency (commonness). Word Ladder's tiers are bucketed
    by this alone (`scripts/compute_word_ladder_graph.py: TIER_FLOOR`).
  - *Solver-measured hardness* — Hangman's tiers are bucketed by a hangman-solving simulation's
    score (`scripts/compute_hangman_difficulty.py`), not raw frequency: at each step the solver
    guesses the letter present in the largest fraction `p` of words still consistent with what's
    revealed, and costs that guess `-log2(p)`/`-log2(1-p)` (present/absent), summed to a
    "difficulty_score" per word — independent of any live guess-limit, so it measures the word's
    *inherent* hardness to guess letter-by-letter, not how forgiving the UI is. A commonness floor
    per tier still gates the bins so "easy" can't contain a word nobody's heard of (full writeup:
    `docs/hangman-difficulty.md`). **If your game's difficulty is about solving strategy rather than
    word obscurity (e.g. anything guessed incrementally, like Hangman), write a small solver
    simulation offline and bucket by its cost — don't substitute raw frequency, which measures a
    different thing.**
- **When a puzzle's solution needs to be *known*, generate it with a real solver, not a guess.**
  Word Ladder needs to know the shortest path between two words exists and has exactly the requested
  step count before it can offer that puzzle to a player. `wordladder.generate_puzzle` does
  rejection sampling: pick a random start, random-walk to a candidate end, then **BFS the actual
  shortest path** (`_bfs_shortest_path`) between them over the precomputed neighbor graph
  (`scripts/compute_word_ladder_graph.py`'s adjacency, built by substitution/indel edit-distance) —
  if the BFS-true shortest path is shorter than requested, the walk is extended and re-solved,
  repeating until they match. This guarantees `par_steps` is never a lie (a player is never asked to
  take the long way by accident) — a puzzle generator that only does the random walk, with no
  solve-and-verify step, would not have this guarantee. The same shape applies to any game whose
  puzzle has a "shortest"/"optimal" claim attached: generate a candidate, then independently solve
  it to confirm (or correct) that claim before exposing it.
- **Generation that can fail or run long belongs in `create_state`, with a bounded-attempts loop and
  a best-effort fallback**, not an unbounded search and not a failure path back to the user —
  `generate_puzzle`'s `GENERATION_ATTEMPTS` cap and `best`-so-far fallback (marked
  `# ponytail: bounded rejection sampling with a best-effort fallback`) is the template: a puzzle
  isn't guaranteed to exist for every length/step/difficulty combination, so give up gracefully and
  return the closest thing found rather than erroring or hanging.

## 4. Redis / state-layer contract (`games/state.py`)

You do not edit this file to add a game, but understand what it assumes about your module so you
don't accidentally violate it:

- `state["status"]` is read directly by `state.py` (`blob["status"] = new_state.get("status", ...)`,
  and `list_games`'s `wordLength` peek) — keep a `status` key in your state even if your game
  doesn't strictly need branching on it elsewhere, and make sure it round-trips through
  `handle_action`'s returned `new_state`.
- A game with no players left is deleted **only if `is_finished(state)` is true**
  (`state.leave_game`) — an unfinished abandoned game just sits until `GAME_TTL` (6h) expires. If
  your game has a "soft loss" state like Hangman's `lost`, the same asymmetry applies: it won't be
  cleaned up early just because everyone left.
- `apply_action`'s `rejected`/`transient` classification is **entirely derived from event kinds**
  (`"invalid"` → rejected; all-of `{"typing", "duplicate"}` → transient) — it never inspects your
  state. Get the event kinds right and the Redis-write-skipping behavior falls out for free.
- Live-typing screen sharing (`sharers`/`allow_sharing`) is generic and lives in `state.py`, not in
  any game module — your game doesn't need to know about it. If your renderer wants to show "what
  this player is typing," send a `"typing"` action and read peers' `"typing"` feed events; don't add
  sharing logic to your own state.

## 5. WebSocket protocol, reconnects, and retries

This is the part most likely to be missed by a new game, since it lives in shared frontend code
(`net.js`) but **requires a small amount of per-game cooperation** to work correctly.

### The transport (`frontend/static/js/net.js`)

- One `WebSocket`, auto-reconnecting with exponential backoff (1s → 2s → 4s → 8s → capped at 10s)
  on any close the app didn't request (`wantConnection` stays true). On reconnect it re-sends
  `hello` (with the stable `cid` from `localStorage`), which re-registers presence server-side.
- **No queue** — only the single most-recently-attempted action is remembered while disconnected
  (`pendingAction`), overwriting any earlier one. Don't assume every action you fire while offline
  will eventually be sent; only the last one is, once the connection comes back and `welcome`
  arrives.
- **Transient message types are dropped, not queued**, while disconnected — `TRANSIENT = {"ping",
  "typing"}`. If your game adds another high-frequency, no-state-change action, add its `type`
  string here too (or its `data`'s outer message `type` if you're sending it as `game_action` —
  note `net.js`'s `TRANSIENT` set keys off the *message* `type`, currently only literal `"ping"`/
  `"typing"`; all real game moves go through `"game_action"` regardless of their inner `action`, so
  this set in practice only matters for genuinely new top-level message types, not new
  `handle_action` action names).
- A queued/pending action is replayed **after** `welcome`'s other handlers run (specifically after
  the app's `welcome` handler re-sends `open_game` to rejoin the current game server-side) — so a
  replayed `game_action` always lands after the server has re-associated the connection with its
  game. You don't need to do anything for this to work as long as your renderer's `open(gameId)` is
  driven by the `"game"` message (see below), not by some other means.

### What "rejoin after reconnect" requires from your renderer

In `app.js`'s `welcome` handler: if `activeGameType` is set and the controller's `currentGame()`
matches a game that's currently shown, it sends `open_game` again. This only works if your
controller:

- Tracks its own `gid` and exposes it via `currentGame()` (see every existing controller's
  `currentGame: () => gid`).
- Doesn't clear that `gid` on disconnect — only on an explicit `leave_game`/`game_closed`/navigating
  back to the lobby (see `Wordle.reset()` vs `Wordle.open()`).

### The "zombie connection" problem — per-action ack timeouts

A socket can report `OPEN` while actually being dead (laptop sleep, NAT timeout) — the browser
hasn't fired `close` yet, so `net.js`'s disconnected-queue path never kicks in; `send()` happily
"succeeds" into the void. **Any action where silently losing the send would strand the player
(typically: the one state-changing move a turn) needs its own watchdog.** Wordle's pattern
(`wordle.js`):

1. On sending a guess, generate a `requestId` (`crypto.randomUUID()` or a timestamp fallback) and
   include it in `data`.
2. Arm a `setTimeout` (`GUESS_ACK_TIMEOUT_MS`, 5s) right after sending.
3. If a new snapshot row or a `rejected` arrives before the timeout, the guess resolved normally —
   clear the timer.
4. If the timeout fires with the guess still pending, call `Net.forceRetry(type, payload)` — same
   payload, same `requestId` — instead of `Net.send`. `forceRetry` tears down the old socket
   without waiting for its `onclose` (which would otherwise race a fresh reconnect), opens a new
   one immediately, and replays once `welcome` arrives. Re-arm the watchdog after a forced retry, in
   case the new connection stalls too.
5. **The matching backend requirement: `handle_action` must treat a resend with the same `requestId`
   from the same `pid` as a no-op** (see §2.5) — otherwise a forced retry double-applies the move.

**Checklist for a new game's "the one move that must not be lost":** generate a `requestId` client
side → send it in `data` → arm an ack timeout → `forceRetry` with the same `requestId` on timeout →
clear timeout on the next relevant snapshot/rejection → server-side duplicate check on
`(pid, requestId)`. Actions that are naturally idempotent or low-stakes if lost (Word Ladder's
`set_word` — last write wins, a lost keystroke just means retyping a box) don't need this whole
apparatus; reserve it for irreversible/once-only moves.

### Server → client message types your controller must handle

From `consumers.py`'s protocol summary — your renderer needs handlers for at least:

| Message | When | Your controller should |
|---|---|---|
| `game` `{snapshot}` | Any time your game's state changes, including on (re)join | Re-render fully from `snapshot.board` (`applySnapshot`). Never mutate local state instead of using the snapshot — the server is authoritative. |
| `feed` `{event}` | A transient event (today: `typing`) relayed live, not stored | `onFeed(event)` — used for ephemera, not state. |
| `rejected` `{reason}` | Your `handle_action` returned an `invalid` event, for the actor only | `onRejected(reason)` — clear any optimistic/pending UI, show why. |
| `game_closed` `{gameId}` | Owner deleted the game while you were in it | Reset to lobby (handled generically in `app.js`, not per-game). |

## 6. Frontend: renderer + view

- **One controller module** per game (`frontend/static/js/<yourgame>.js`), structured as an IIFE
  returning a small public object — match `Wordle`'s shape: `init(refs)`, `setMyId(id)`, `open(gid)`,
  `reset()`, `applySnapshot(snap)`, `onFeed(event)`, `input(key)` (if there's keyboard input),
  `onRejected(reason)`, `currentGame()`.
- **Fully re-render from each snapshot.** Don't carry authoritative state in the controller beyond
  what's needed for in-flight local interaction (an unsubmitted guess, cursor position, a pending
  watchdog) — the server's `board` is the single source of truth. This is what makes reconnect
  replay (§5) safe: a missed snapshot is just caught up by the next one.
- **`open(gid)` resets local-only UI state** (typing buffer, cursor, pending guess, peer-typing map,
  any ack timer) — called both on first entering a game and implicitly trusted not to be called
  again on a reconnect rejoin (the server resends a fresh snapshot instead).
- Add a `<section id="<yourgame>-game" class="view">` to `frontend/templates/index.html`, and a
  `<script src="{% static 'js/yourgame.js' %}">` tag — **load order matters**: dependency order, so
  before `app.js` (which references your controller by name) and after anything it depends on
  (`net.js`, `board.js`/`keyboard.js`-equivalents if reused).
- Wire it into `app.js`'s `GAME_VIEWS` map: `yourgame: { viewId: "yourgame-game", controller: YourGame }`.
  This is the **only** place `app.js` needs a per-game-type entry for snapshot routing, view
  switching, and reconnect-rejoin to work generically — don't add another `if (gameType === ...)`
  branch elsewhere if a `GAME_VIEWS` lookup would do.
- If your game needs physical-keyboard input, add a branch in `app.js: wireKeyboard()` keyed off
  `activeGameType` (see the `wordle`/`wordladder` Enter-key handling) — this is one of the few
  legitimately per-game-type branches outside `GAME_VIEWS`, since key bindings genuinely differ.
- Reuse shared rendering helpers where your game's shape matches: `board.js` (Wordle's grid),
  `ladderboard.js` (Word Ladder's per-player grid), `keyboard.js` (on-screen keyboard + hint
  coloring). Only write a new one if your game's display is genuinely novel.
- If your game uses the live-typing screen-share feature, follow Wordle's pattern: a personal
  share-toggle button (`share_start`/`share_stop`), a host-only `set_allow_sharing` checkbox, and
  gate showing peers' `typing` feed events behind `iAmSharing()` (you only see others' live typing
  while sharing your own).

## 7. Caret, insert vs. overwrite mode, and the space bar

Two different text-entry models are in use, and which one fits depends entirely on whether a row's
length is fixed:

- **Fixed-length entry → overwrite mode, a box-index cursor.** Wordle's `cells` (one slot per box)
  and Word Ladder's `substitute` mode both work this way: `cursorPos` is a box index
  (`0..wordLength`), typing a letter always *replaces* whatever's in the box the cursor is on and
  advances by one, and backspace clears the box *behind* the cursor (never the one it's sitting on —
  same convention a caret has in any editor: it sits *between* characters, so backspace removes
  what's to its left). There is no shift-the-rest-along insert/delete, because every box is always
  exactly one letter wide — there's nothing to shift. Boxes can be clicked/arrowed to directly and
  retyped in any order. This is the right model whenever the puzzle's answer length is known and
  fixed in advance (a Wordle row, a fixed-length ladder rung).
- **Variable-length entry → real insert/delete, a text-style caret.** Word Ladder's
  `insert_delete` mode uses a plain string `buffer` and a caret that's a *gap position*
  (`0..buffer.length`, not a box index): typing inserts a character at the caret and shifts
  everything after it along; backspace deletes the character before the caret and shifts the rest
  back; the row's visual width grows/shrinks with `buffer.length` rather than being fixed. This is
  the right model whenever a row's length isn't determined ahead of time (an `insert_delete`-mode
  rung may legitimately be shorter or longer than its neighbors).
- **Don't mix the two cursor semantics on one row.** `cursorPos`'s *meaning* (box index vs. caret
  gap) is fixed per game/mode, decided once from a value like `editMode`, never per-keystroke — see
  `wordladder.js`'s `input()` branching on `substitute` once at the top, not re-deriving which
  model applies on every key.
- **Click-to-position the caret the same way in both modes**: split the clicked tile down the
  middle and land the caret on whichever side the click was closer to (see `board.js` and
  `ladderboard.js`'s identical `before = e.clientX - rect.left < rect.width / 2` — this is the one
  piece of caret-placement logic worth copying verbatim into a new board renderer rather than
  reinventing).
- **The on-screen keyboard's SPACE key is only for variable-length entry**, and only because it has
  no physical-keyboard equivalent reachable on a touchscreen — it inserts a blank placeholder
  character. A fixed-length game/mode has no use for it (every box already exists; there's nothing
  to insert) and `Keyboard.create`'s `opts.allowSpace`/`setSpaceVisible` keep it hidden unless the
  active mode actually needs it (Word Ladder shows/hides it per-game by calling
  `setSpaceVisible(editMode !== "substitute")`, not by building two separate keyboards). **Add a
  SPACE key only if your game has genuinely variable-length entry; don't add it "just in case" for
  a fixed-length game** — it has no physical-key equivalent to mirror, so it's pure UI surface for a
  case that can't occur.

## 8. Physical keyboard vs. touchscreen virtual keyboard

Every game must be fully playable two ways, and a new game's input handling has to serve both
without one degrading the other:

- **A larger-screen / physical-keyboard device** types on the actual keyboard. `app.js: wireKeyboard()`
  listens for real `keydown` events and funnels them into the same `input(key)` call the on-screen
  keyboard's clicks use (see `keyboard.js`'s header comment: "Physical-keyboard input is handled in
  app.js and funnelled through the same `onKey` callback") — there is exactly one code path per
  game for "a key was pressed," regardless of source. **Never give the physical-keyboard handler
  logic the on-screen keyboard doesn't also trigger, or vice versa** — that's the surest way to end
  up with a game that works on a laptop but is subtly broken (or missing an action entirely) on a
  touchscreen, or the reverse.
- **A touchscreen device has no physical keyboard**, so the on-screen `Keyboard`/`Board`/
  `LadderBoard` components are not an optional convenience — they're the *only* input surface for
  that device. Anything reachable only via a physical key (arrow-key row navigation, say) needs an
  on-screen equivalent reachable by tap (clicking a different row/tile, as Word Ladder's
  `selectCell`/`focusRow` already do) or it's simply unplayable on mobile.
  - The SPACE row (§7) exists specifically because a touchscreen has no spacebar equivalent inside
    the page otherwise — it's the canonical example of "this needs an on-screen control because the
    physical-keyboard path doesn't reach mobile at all."
- **Click/tap targets need to work as both `click` (mouse/trackpad on a laptop) and tap
  (touchscreen)** — the codebase relies on the browser treating a tap as a `click` event rather than
  binding separate `touchstart`/`pointerdown` handlers; don't add a touch-only or mouse-only
  handler unless a feature genuinely needs to distinguish them (hover-only affordances don't exist
  on touch — don't gate any required action behind hover).
- **Extra testing beyond the unit tests in §11**: because a single logic path serves two physically
  different input devices, a new game's manual/e2e testing should explicitly exercise *both*, not
  just whichever one is convenient while developing:
  - Play a full game using only physical-keyboard key presses (no clicks on the on-screen keyboard
    at all) — confirms `wireKeyboard()`'s branch for your `activeGameType` covers every action your
    game needs (entering letters, submitting, navigating between rows, any reveal/special action).
  - Play a full game using only on-screen-keyboard/tile taps (no physical key presses) — confirms
    nothing requires a key that has no on-screen equivalent.
  - Resize to (or test directly at) a touchscreen-scale mobile viewport and confirm tap targets
    (tiles, keyboard keys, the SPACE row if present) are large enough and that nothing relies on a
    `:hover` state to be usable.
  - **Current e2e coverage (`tests_e2e/test_hangman.py` etc.) only drives the on-screen keyboard via
    `page.click(...)`** — it does not exercise the physical-keydown path through `wireKeyboard()` at
    all. A new game's e2e test should add at least one scenario using Playwright's
    `page.keyboard.press(...)` against the physical path, rather than only repeating the
    click-based pattern of the existing tests — otherwise the physical-keyboard branch in
    `wireKeyboard()` for your game has no test coverage whatsoever.

## 9. Create-game options & validation UI

- The lobby's NEW GAME modal posts `create_game {gameType, options}`; `options` is whatever shape
  your `validate_options`/`create_state` expect (camelCase keys: `wordLength`, `editMode`, etc.).
- Add a per-game options panel in `index.html` (`data-gametype-panel="yourgame"`, toggled by
  `app.js: showGameTypePanel`) and read its fields into `options` in `app.js`'s submit handler
  (currently a per-`gameType` `if` block around line 417-474 — yes, this is the one place that
  *does* hardcode game types one by one; there's no registry-driven generic form builder, so a new
  game adds one more `if` branch here).
- Surface `validate_options`'s error string via the `create_error` message (`showModalError`) —
  don't invent a separate client-side validation path that could disagree with the server's.

## 10. Logging, the activity feed, and naming your game in lists

There is **no single registry the frontend reads for a game's display name** — `LABEL` only drives
the lobby's NEW GAME picker (`game_type_list()`). The current-games list, the recent-games history,
and the activity feed each independently format a name from `gameType`, and a new game has to be
added in all of them or it'll show up as a raw key or a generic fallback in some of them:

- **Current games (lobby list, `lobby.js: renderGames`)**: no per-game label map at all — it just
  upper-cases the raw `gameType` string (`g.gameType.toUpperCase()`), optionally suffixed with
  `(wordLength)` if `state.py: list_games` found a `word_length` key on the state (a peek that's
  only meaningful for length-based games; it's silently absent for Hangman). **You don't need to
  add anything here for a new game to show up correctly** unless you want a length-style
  parenthetical, in which case add a similar targeted peek in `state.py: list_games` (don't
  generalize it into reading the whole state — keep it a narrow, named field like `word_length`).
- **Recent games / history (`lobby.js: renderHistory`)**: also has no per-game branching — it
  renders generically from `result()`'s `answer` (uppercased) plus `won`/`guessesUsed`/`maxGuesses`.
  This is exactly why `result()`'s `answer` must be a **complete, self-contained, human-readable
  summary** (§2) rather than a bare word: Word Ladder's `answer` is formatted as
  `f"{start_word} → {end_word}"` specifically so the generic history renderer — which has no idea
  what kind of game it's summarizing — still produces a sensible line. If your game's natural
  "what happened" doesn't fit the `won`/`guesses_used`/short-`answer` shape well, make `answer` do
  the work of explaining it rather than trying to add per-game-type branching to `renderHistory`.
- **Activity feed (`activity.js`)**: this one *does* need a per-game entry — its own
  `GAME_LABELS` map (`{wordle: "Wordle", hangman: "Hangman", wordladder: "Word Ladder"}`, used only
  by the `"game_created"` event's `started a <Label>` line) is a **third, independent copy** of the
  same display name already in Python's `LABEL` and conceptually duplicated by app.js's `GAME_VIEWS`
  comment. There is no shared source for it across Python/JS. **Add your game's display name to
  `activity.js: GAME_LABELS` too** — it will silently fall back to the generic word `"game"`
  otherwise, which is easy to miss because nothing errors.
  - **ponytail: three independent name copies (`LABEL` in Python, `GAME_LABELS` in activity.js, the
    raw-uppercase fallback everywhere else) is one too many to keep in sync by hand** — if a fourth
    game type makes the drift actually bite (a wrong/missing label shipped), it's worth exposing
    `LABEL` to the frontend via the existing `game_types` API (`views.py: game_types`, already
    fetched once into `gameTypesLoaded`) and having `activity.js` read from that cache instead of
    its own map, rather than adding a fourth copy.
- **Per-move/event log entries (`activity.js: fmtEvent`)**: every event `kind` your `handle_action`
  emits that should appear in the activity feed needs its own `switch` branch here (mirroring the
  one already required in `consumers.py: _game_action`, §2.7) — there is no generic fallback beyond
  printing the raw `kind` string, so an unhandled kind reads as a bare word like `letter_guess`
  instead of a sentence. Keep the convention of building each line from `.get()` on fields specific
  to your event (don't assume `ev.word`/`ev.marks` exist for a non-Wordle-shaped event — see how
  `markSuffix` is conditional on `ev.marks` being present at all, omitted entirely rather than
  rendering a dangling space for game types that don't have it).
- Nothing here is itself a server-side application log — there is no separate logging framework
  convention beyond what's already covered: durable per-game events live in `state.py`'s `feed`
  (capped at `FEED_MAX`) and the global cross-session `ActivityEvent` table (`games/models.py`,
  kept forever, fed by `consumers.py: _broadcast_activity`/`push_activity`). A new game doesn't add
  logging infrastructure — it just needs to emit the right event `kind`s (§2.7) for the existing
  activity pipeline to pick up, and a rendering branch for each of them as above.

## 11. Tests

- `games/tests/test_<yourgame>.py`: unit tests for the pure rules, calling module functions
  directly — no Django test client, no Redis, no async. Cover at minimum: the scoring/win logic, the
  `invalid` rejection paths and their `reason` codes, the `is_finished` boundary, and any retry/
  idempotency behavior (`requestId` duplicate handling) if your game implements it.
- Put randomness behind a seam and monkeypatch it (`pick_word`, or Word Ladder's
  `generate_puzzle` parameters) rather than asserting on a specific random outcome.
- If the cooperative interaction differs meaningfully from Wordle's (e.g. per-player boards,
  multi-step generation), extend the e2e Playwright flow (`tests_e2e/`) — see
  `tests_e2e/test_hangman.py` for the precedent of a second game getting its own e2e file rather
  than overloading `test_new_game.py`.
- Your e2e file should include both an on-screen-keyboard/tap-driven scenario and at least one
  physical-keyboard (`page.keyboard.press`) scenario — see §8; every existing e2e test only drives
  the click path, so the physical path is otherwise unverified.

## 12. New-game checklist

- [ ] `games/gametypes/<yourgame>.py`: `KEY`, `LABEL`, `create_state`, `validate_options`,
      `handle_action`, `is_finished`, `snapshot`, `result`
- [ ] Registered in `games/gametypes/__init__.py: GAME_TYPES`
- [ ] State carries its own rule parameters (not just module constants) and a `status` field
- [ ] Every rejection path uses `{"kind": "invalid", "reason": "..."}`, checked early for
      already-finished (unless deliberately post-finish, like a reveal)
- [ ] Transient/no-state-change actions get a dedicated event kind handled by `apply_action`'s
      existing transient check (no state.py change needed) — and added to `net.js`'s `TRANSIENT`
      set if they're a new top-level message type
- [ ] Any irreversible one-shot move supports `requestId`-based duplicate detection
- [ ] `snapshot()` hides secrets until `is_finished`, uses camelCase keys, is self-describing
- [ ] `result()` returns `{won, answer, guesses_used}`, `answer` fits 32 chars
- [ ] `games/tests/test_<yourgame>.py` covering rules, rejections, finish boundary, idempotency
- [ ] Word source(s) added to `wordlists.py` (cached loader) + a generation script if precomputed;
      difficulty tiers (if any) bucketed offline by the right axis (obscurity vs. solver-measured
      hardness) — never computed at request time
- [ ] If the puzzle has a "shortest"/"optimal" claim, it's verified by an actual solver
      (BFS/equivalent), not assumed from how it was generated
- [ ] `frontend/static/js/<yourgame>.js` controller with the standard public shape
- [ ] `<section id="<yourgame>-game" class="view">` + `<script>` tag added in dependency order
- [ ] `GAME_VIEWS` entry in `app.js`
- [ ] Cursor model picked deliberately: overwrite/box-index for fixed-length entry, insert/delete
      with a real caret for variable-length entry — not mixed on one row
- [ ] On-screen SPACE key added only if entry is genuinely variable-length (`Keyboard`'s
      `allowSpace`/`setSpaceVisible`) — omitted for fixed-length games/modes
- [ ] Keyboard wiring in `wireKeyboard()` if applicable, and every action it triggers is also
      reachable from the on-screen keyboard/board (and vice versa) — test both input paths
      end-to-end, including a `page.keyboard.press`-driven e2e scenario, not just clicks
- [ ] Create-game options panel + `if` branch in the modal submit handler
- [ ] If using a single state-changing "the one move that matters": client-side ack timeout +
      `forceRetry`, matched by server-side `requestId` duplicate handling
- [ ] Display name added to `activity.js: GAME_LABELS` (no shared registry exists yet — see §10)
- [ ] A rendering branch in `activity.js: fmtEvent` for every new event `kind` you emit
- [ ] `result()`'s `answer` reads as a complete summary on its own — the generic recent-games list
      has no per-game-type formatting to lean on
