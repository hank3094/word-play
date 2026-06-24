"""Registry of cooperative game types.

Each game type is a module exposing the same pure interface::

    KEY, LABEL
    create_state() -> dict
    handle_action(state, pid, name, action, data) -> (new_state, events)
    snapshot(state) -> dict
    is_finished(state) -> bool
    result(state) -> dict

To add a game (bananagrams, word search, crossword, …): implement such a module here and register
it in ``GAME_TYPES``, then add a matching client renderer. The consumer, Redis state store, lobby,
and feed are all game-agnostic. See docs/adding-a-game.md.
"""

from . import hangman, wordladder, wordle

GAME_TYPES = {wordle.KEY: wordle, hangman.KEY: hangman, wordladder.KEY: wordladder}


def get_game_type(key: str):
    """Return the game-type module for ``key``, or None if unknown."""
    return GAME_TYPES.get(key)


def game_type_list() -> list[dict]:
    """Lightweight list for the lobby's NEW GAME picker."""
    return [{"key": m.KEY, "label": m.LABEL} for m in GAME_TYPES.values()]
