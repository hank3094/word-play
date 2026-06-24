"""Word lists for the Wordle game, loaded once from the shipped text files.

Per-length files (``answers_4.txt``, ``allowed_6.txt``, etc.) are used when present;
otherwise falls back to the original ``answers.txt`` / ``allowed.txt`` (5-letter defaults).
A guess is valid if it is in either set, so every answer is always a legal guess.
"""

import json
from functools import cache
from pathlib import Path

_WORDS_DIR = Path(__file__).resolve().parent / "words"


def _load(name: str) -> frozenset[str]:
    path = _WORDS_DIR / name
    try:
        text = path.read_text()
    except FileNotFoundError:
        return frozenset()  # e.g. a length/tier with no generated word list -- just no words
    return frozenset(line.strip().lower() for line in text.splitlines() if line.strip())


@cache
def answers(word_length: int = 5) -> tuple[str, ...]:
    """Curated secret-word pool for the given length, as a sorted tuple."""
    specific = f"answers_{word_length}.txt"
    name = specific if (_WORDS_DIR / specific).exists() else "answers.txt"
    return tuple(sorted(_load(name)))


@cache
def allowed(word_length: int = 5) -> frozenset[str]:
    """All words accepted as a guess: the per-length dictionary plus every answer."""
    specific = f"allowed_{word_length}.txt"
    name = specific if (_WORDS_DIR / specific).exists() else "allowed.txt"
    return _load(name) | frozenset(answers(word_length))


@cache
def hangman_words(difficulty: str = "medium") -> tuple[str, ...]:
    """Hangman's secret-word pool for the given difficulty tier, as a sorted tuple.

    Unlike Wordle's per-length pools, these aren't bounded to 4-7 letters — hangman words can be
    much longer (see scripts/compute_hangman_difficulty.py). No "allowed guesses" counterpart
    exists since hangman guesses are single letters, not whole words.
    """
    return tuple(sorted(_load(f"hangman_{difficulty}.txt")))


LADDER_TIERS = ("easy", "medium", "hard", "nightmare")


@cache
def ladder_words(length: int, tier: str | None = None) -> frozenset[str]:
    """Word Ladder's dictionary for a given length, either one commonality tier (see
    scripts/compute_word_ladder_graph.py) or, with no tier, every word of that length --
    the pool used for "is this a real word" checks during play, independent of difficulty."""
    if tier is None:
        return frozenset().union(*(ladder_words(length, t) for t in LADDER_TIERS))
    return _load(f"ladder_{length}_{tier}.txt")


@cache
def ladder_tier_of(length: int) -> dict[str, str]:
    """word -> commonality tier, for the given length."""
    return {w: t for t in LADDER_TIERS for w in ladder_words(length, t)}


@cache
def ladder_neighbors(length: int) -> dict[str, tuple[str, ...]]:
    """Precomputed edit-adjacency for words of this length: word -> neighbor words, which may
    be this length (a substitution) or length-1/length+1 (an insertion/deletion)."""
    path = _WORDS_DIR / f"ladder_graph_{length}.json"
    try:
        raw: dict[str, list[str]] = json.loads(path.read_text())
    except FileNotFoundError:
        return {}  # e.g. a length with no generated graph -- just no neighbors
    return {w: tuple(ns) for w, ns in raw.items()}
