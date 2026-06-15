"""Word lists for the Wordle game, loaded once from the shipped text files.

``answers`` is a curated set of common, friendly five-letter words used as secret words.
``allowed`` is a larger dictionary of valid guesses (sourced from a system word list). A guess is
valid if it is in either set, so every answer is always a legal guess.
"""

from functools import cache
from pathlib import Path

_WORDS_DIR = Path(__file__).resolve().parent / "words"


def _load(name: str) -> frozenset[str]:
    path = _WORDS_DIR / name
    return frozenset(line.strip().lower() for line in path.read_text().splitlines() if line.strip())


@cache
def answers() -> tuple[str, ...]:
    """Curated secret-word pool, as an ordered tuple (so random.choice is stable per seed)."""
    return tuple(sorted(_load("answers.txt")))


@cache
def allowed() -> frozenset[str]:
    """All words accepted as a guess: the dictionary plus every answer."""
    return _load("allowed.txt") | frozenset(answers())
