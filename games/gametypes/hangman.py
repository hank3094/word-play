"""Cooperative Hangman: pure game rules (no Redis, no I/O beyond the word lists).

A game is a single shared secret word. Any player may guess a letter; the masked word and gallows
are shared by everyone in the game. State shape::

    {"word": "balloon",
     "guessed": ["a", "o"],
     "wrong_letters": ["x"],
     "difficulty": "medium",
     "status": "playing",
     "max_wrong": 6}

``status`` is one of ``playing`` | ``lost`` | ``won`` | ``revealed``. Unlike Wordle, ``lost`` is
**not** a finishing status: once the gallows is fully drawn, players may keep guessing letters (and
could still reach ``won``), or any player may ``reveal`` the word to truly end the game. The word
is never exposed in a snapshot until the game is finished (``won`` or ``revealed`` — not ``lost``).

Random words come from a difficulty-tiered pool (see ``wordlists.hangman_words`` and
``scripts/compute_hangman_difficulty.py``) rather than Wordle's length-bounded lists, so hangman
words can be much longer than 7 letters. Difficulty tiers are based on a hangman-solver simulation
(see that script's docstring), not raw word frequency. ``difficulty`` only matters for word
*selection* at creation time; it's stored on the state purely for display.

A hangman game stuck at ``status == "lost"`` with everyone gone won't be auto-deleted by
``state.py::leave_game`` the way a finished Wordle game would (since ``is_finished`` is False) — it
just sits until the normal Redis TTL expiry. This is an accepted, intentional asymmetry: nobody
explicitly ended the game, so it isn't cleaned up early.
"""

from __future__ import annotations

import random

from .. import wordlists

KEY = "hangman"
LABEL = "Hangman"
MAX_WRONG = 10
MIN_WORD_LEN = 2
MAX_WORD_LEN = 24  # comfortably under FinishedGame.answer's 32-char CharField
DIFFICULTIES = ("easy", "medium", "hard", "nightmare")
DEFAULT_DIFFICULTY = "medium"

PLAYING, LOST, WON, REVEALED = "playing", "lost", "won", "revealed"


def pick_word(difficulty: str = DEFAULT_DIFFICULTY) -> str:
    return random.choice(wordlists.hangman_words(difficulty))


def _clean_difficulty(value) -> str:
    d = str(value or "").strip().lower()
    return d if d in DIFFICULTIES else DEFAULT_DIFFICULTY


def validate_options(options: dict) -> str | None:
    """Check the create-game options. Returns an error message, or None if they're fine."""
    opts = options or {}
    word = str(opts.get("word") or "").strip().lower()
    if not word:
        return None
    if not word.isalpha():
        return "The word must contain only letters."
    if not (MIN_WORD_LEN <= len(word) <= MAX_WORD_LEN):
        return f"The word must be between {MIN_WORD_LEN} and {MAX_WORD_LEN} letters."
    return None


def create_state(options: dict | None = None) -> dict:
    opts = options or {}
    difficulty = _clean_difficulty(opts.get("difficulty"))

    word = str(opts.get("word") or "").strip().lower()
    if not (word.isalpha() and MIN_WORD_LEN <= len(word) <= MAX_WORD_LEN):
        word = pick_word(difficulty)

    return {
        "word": word,
        "guessed": [],
        "wrong_letters": [],
        "difficulty": difficulty,
        "status": PLAYING,
        "max_wrong": MAX_WRONG,
    }


def is_finished(state: dict) -> bool:
    return state.get("status") in (WON, REVEALED)


def handle_action(state: dict, pid: str, name: str, action: str, data: dict):
    """Apply a player's action. Returns ``(new_state, events)``.

    ``events`` is a list of dicts. ``{"kind": "invalid", ...}`` means the action was rejected and
    the state is unchanged (only the acting player should be notified). Routine letter guesses
    emit ``{"kind": "letter_guess", ...}`` (deliberately not ``"guess"`` — see consumers.py, which
    treats that kind as Wordle-shaped). A winning guess also emits ``win``; the *first* wrong
    guess to exhaust ``max_wrong`` also emits ``lose`` (never re-emitted on later wrong guesses,
    since losing doesn't end the game here). ``reveal`` emits ``revealed``.
    """
    max_wrong = state.get("max_wrong", MAX_WRONG)

    if action == "reveal":
        if state.get("status") != LOST:
            return state, [{"kind": "invalid", "reason": "not_lost"}]
        new_state = {**state, "status": REVEALED}
        return new_state, [{"kind": "revealed", "name": name, "word": state["word"]}]

    if is_finished(state):
        return state, [{"kind": "invalid", "reason": "finished"}]

    if action != "guess_letter":
        return state, [{"kind": "invalid", "reason": "unknown_action"}]

    letter = str(data.get("letter", "")).strip().lower()
    if len(letter) != 1 or not letter.isalpha():
        return state, [{"kind": "invalid", "reason": "invalid_letter"}]
    if letter in state["guessed"]:
        return state, [{"kind": "invalid", "reason": "already_guessed", "letter": letter}]

    guessed = [*state["guessed"], letter]
    wrong_letters = state["wrong_letters"]
    correct = letter in state["word"]
    old_status = state["status"]
    status = old_status

    if correct:
        word_letters = {c for c in state["word"] if c.isalpha()}
        if word_letters <= set(guessed):
            status = WON
    else:
        wrong_letters = [*wrong_letters, letter]
        if old_status == PLAYING and len(wrong_letters) >= max_wrong:
            status = LOST

    new_state = {**state, "guessed": guessed, "wrong_letters": wrong_letters, "status": status}
    events = [{"kind": "letter_guess", "name": name, "letter": letter, "correct": correct}]
    if status == WON:
        events.append({"kind": "win", "name": name, "word": state["word"]})
    elif status == LOST and old_status != LOST:
        events.append({"kind": "lose", "answer": state["word"]})
    return new_state, events


def snapshot(state: dict) -> dict:
    word = state["word"]
    max_wrong = state.get("max_wrong", MAX_WRONG)
    guessed = set(state["guessed"])
    finished = is_finished(state)
    masked = "".join(ch if (not ch.isalpha()) or ch in guessed else "_" for ch in word)
    return {
        "maskedWord": masked,
        "wordLength": len(word),
        "guessed": sorted(state["guessed"]),
        "wrongLetters": sorted(state["wrong_letters"]),
        "wrongCount": min(len(state["wrong_letters"]), max_wrong),
        "maxGuesses": max_wrong,
        "difficulty": state.get("difficulty", DEFAULT_DIFFICULTY),
        "status": state["status"],
        # Revealed only once the game is truly over (won/revealed) — "lost" still hides it, since
        # players may keep guessing.
        "word": word if finished else None,
    }


def result(state: dict) -> dict:
    return {
        "won": state["status"] == WON,
        "answer": state["word"],
        "guesses_used": len(state["guessed"]),
    }
