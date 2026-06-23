"""Unit tests for the word-list loaders."""

from games import wordlists


def test_hangman_words_all_difficulty_tiers_nonempty():
    for difficulty in ("easy", "medium", "hard", "nightmare"):
        words = wordlists.hangman_words(difficulty)
        assert len(words) > 0
        assert all(w.isalpha() for w in words)


def test_hangman_words_sorted_and_deduped():
    words = wordlists.hangman_words("easy")
    assert list(words) == sorted(set(words))


def test_wordle_answers_and_allowed_still_work():
    assert "crane" in wordlists.answers(5)
    assert "crane" in wordlists.allowed(5)
