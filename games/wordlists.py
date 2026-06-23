"""Word lists for the Wordle game, loaded once from the shipped text files.

Per-length files (``answers_4.txt``, ``allowed_6.txt``, etc.) are used when present;
otherwise falls back to the original ``answers.txt`` / ``allowed.txt`` (5-letter defaults).
A guess is valid if it is in either set, so every answer is always a legal guess.
"""

from functools import cache
from pathlib import Path

_WORDS_DIR = Path(__file__).resolve().parent / "words"


def _load(name: str) -> frozenset[str]:
    path = _WORDS_DIR / name
    return frozenset(line.strip().lower() for line in path.read_text().splitlines() if line.strip())


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
