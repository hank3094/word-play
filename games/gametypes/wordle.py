"""Cooperative Wordle: pure game rules (no Redis, no I/O beyond the word lists).

A game is a single shared 6x5 board. Any player may submit a guess; the board and its colour
feedback are shared by everyone in the game. State shape::

    {"answer": "crane",
     "rows": [{"by": "ANA", "word": "slate", "marks": ["miss", ...]}],
     "status": "playing",
     "word_length": 5,
     "max_guesses": 6}

``status`` is one of ``playing`` | ``won`` | ``lost``. The answer is never exposed in a snapshot
until the game is finished.  ``word_length`` and ``max_guesses`` are stored in the state dict so
each game is self-describing; the module constants are fallbacks for backward compat.
"""

from __future__ import annotations

import random
from collections import Counter

from .. import wordlists

KEY = "wordle"
LABEL = "Wordle"
WORD_LENGTH = 5  # default / backward-compat fallback
MAX_GUESSES = 6  # default / backward-compat fallback
VALID_LENGTHS = frozenset({4, 5, 6, 7})

PLAYING, WON, LOST = "playing", "won", "lost"
HIT, PRESENT, MISS = "hit", "present", "miss"

# Keyboard-hint precedence: a letter shows its best-known state across all guesses.
_RANK = {MISS: 0, PRESENT: 1, HIT: 2}


def pick_word(word_length: int = WORD_LENGTH) -> str:
    return random.choice(wordlists.answers(word_length))


def is_allowed(word: str, word_length: int = WORD_LENGTH) -> bool:
    return word.lower() in wordlists.allowed(word_length)


def score_guess(guess: str, answer: str) -> list[str]:
    """Per-letter marks with correct duplicate handling: greens first, then yellows.

    >>> score_guess("crane", "crane")
    ['hit', 'hit', 'hit', 'hit', 'hit']
    >>> score_guess("pppap", "apple")  # only as many yellows/greens as the answer has
    ['miss', 'present', 'present', 'present', 'miss']
    """
    guess = guess.lower()
    answer = answer.lower()
    marks = [MISS] * len(guess)
    remaining = Counter(answer)
    for i, ch in enumerate(guess):  # exact-position hits first
        if i < len(answer) and ch == answer[i]:
            marks[i] = HIT
            remaining[ch] -= 1
    for i, ch in enumerate(guess):  # then present-elsewhere from what's left
        if marks[i] == HIT:
            continue
        if remaining.get(ch, 0) > 0:
            marks[i] = PRESENT
            remaining[ch] -= 1
    return marks


def validate_options(options: dict) -> str | None:
    """Check the create-game options. Returns an error message, or None if they're fine."""
    opts = options or {}
    try:
        word_length = int(opts.get("wordLength", WORD_LENGTH))
    except (TypeError, ValueError):
        return "wordLength must be a number."
    if word_length not in VALID_LENGTHS:
        return f"Word length must be one of {sorted(VALID_LENGTHS)}."

    word = str(opts.get("word") or "").strip().lower()
    if not word:
        return None
    if len(word) != word_length or not word.isalpha():
        return f"The word must be {word_length} letters."
    if not is_allowed(word, word_length):
        return "That isn't in our word list."
    return None


def create_state(options: dict | None = None) -> dict:
    opts = options or {}
    try:
        word_length = int(opts.get("wordLength", WORD_LENGTH))
    except (TypeError, ValueError):
        word_length = WORD_LENGTH
    if word_length not in VALID_LENGTHS:
        word_length = WORD_LENGTH
    max_guesses = word_length + 1

    word = str(opts.get("word") or "").strip().lower()
    answer = (
        word
        if (len(word) == word_length and word.isalpha() and is_allowed(word, word_length))
        else pick_word(word_length)
    )
    return {
        "answer": answer,
        "rows": [],
        "status": PLAYING,
        "word_length": word_length,
        "max_guesses": max_guesses,
    }


def is_finished(state: dict) -> bool:
    return state.get("status") in (WON, LOST)


def handle_action(state: dict, pid: str, name: str, action: str, data: dict):
    """Apply a player's action. Returns ``(new_state, events)``.

    ``events`` is a list of dicts. ``{"kind": "invalid", ...}`` means the action was rejected and
    the state is unchanged (only the acting player should be notified). ``{"kind": "typing", ...}``
    is a transient liveness event (no board change). A ``guess`` yields a ``guess`` event plus a
    ``win``/``lose`` event when the game ends.
    """
    word_length = state.get("word_length", WORD_LENGTH)
    max_guesses = state.get("max_guesses", MAX_GUESSES)

    if is_finished(state):
        return state, [{"kind": "invalid", "reason": "finished"}]

    if action == "typing":
        text = str(data.get("text", ""))[:word_length].lower()
        return state, [{"kind": "typing", "pid": pid, "name": name, "text": text}]

    if action == "guess":
        word = str(data.get("word", "")).lower().strip()
        if len(word) != word_length or not word.isalpha():
            return state, [{"kind": "invalid", "reason": "length"}]
        if not is_allowed(word, word_length):
            return state, [{"kind": "invalid", "reason": "unknown", "word": word}]
        marks = score_guess(word, state["answer"])
        rows = [*state["rows"], {"by": name, "word": word, "marks": marks}]
        if all(m == HIT for m in marks):
            status = WON
        elif len(rows) >= max_guesses:
            status = LOST
        else:
            status = PLAYING
        new_state = {**state, "rows": rows, "status": status}
        events = [{"kind": "guess", "name": name, "word": word, "marks": marks}]
        if status == WON:
            events.append({"kind": "win", "name": name, "word": word})
        elif status == LOST:
            events.append({"kind": "lose", "answer": state["answer"]})
        return new_state, events

    return state, [{"kind": "invalid", "reason": "unknown_action"}]


def keyboard_hints(state: dict) -> dict:
    hints: dict[str, str] = {}
    for row in state["rows"]:
        for ch, mark in zip(row["word"], row["marks"], strict=False):
            if ch not in hints or _RANK[mark] > _RANK[hints[ch]]:
                hints[ch] = mark
    return hints


def snapshot(state: dict) -> dict:
    word_length = state.get("word_length", WORD_LENGTH)
    max_guesses = state.get("max_guesses", MAX_GUESSES)
    finished = is_finished(state)
    return {
        "rows": state["rows"],
        "status": state["status"],
        "guessesUsed": len(state["rows"]),
        "maxGuesses": max_guesses,
        "wordLength": word_length,
        "keyboard": keyboard_hints(state),
        # Revealed only once the game is over (so a snapshot can't leak the answer mid-game).
        "answer": state["answer"] if finished else None,
    }


def result(state: dict) -> dict:
    return {
        "won": state["status"] == WON,
        "answer": state["answer"],
        "guesses_used": len(state["rows"]),
    }
