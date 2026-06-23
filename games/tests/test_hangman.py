"""Unit tests for the pure cooperative-Hangman rules."""

from games.gametypes import hangman


def test_pick_word_is_from_the_chosen_difficulty_pool():
    for difficulty in hangman.DIFFICULTIES:
        w = hangman.pick_word(difficulty)
        assert w.isalpha()
        assert hangman.MIN_WORD_LEN <= len(w) <= hangman.MAX_WORD_LEN


def test_create_state_uses_valid_custom_word_of_any_supported_length():
    state = hangman.create_state({"word": "Balloon"})
    assert state["word"] == "balloon"
    # a custom word much longer than Wordle's 7-letter cap is accepted unchanged
    long_word = "internationalization"[: hangman.MAX_WORD_LEN]
    state = hangman.create_state({"word": long_word})
    assert state["word"] == long_word


def test_create_state_falls_back_to_random_for_bad_word():
    state = hangman.create_state({"word": "12345"})
    assert state["word"] != "12345"
    assert state["word"].isalpha()


def test_create_state_random_respects_difficulty():
    state = hangman.create_state({"difficulty": "easy"})
    assert state["difficulty"] == "easy"
    state = hangman.create_state({"difficulty": "bogus"})
    assert state["difficulty"] == hangman.DEFAULT_DIFFICULTY  # invalid -> default


def test_create_state_defaults():
    state = hangman.create_state()
    assert state["status"] == "playing"
    assert state["guessed"] == []
    assert state["wrong_letters"] == []
    assert state["max_wrong"] == hangman.MAX_WRONG
    assert state["difficulty"] == hangman.DEFAULT_DIFFICULTY


def test_validate_options():
    assert hangman.validate_options({}) is None
    assert hangman.validate_options({"word": ""}) is None
    assert hangman.validate_options({"word": "balloon"}) is None
    # no dictionary check — a made-up word is fine, unlike Wordle
    assert hangman.validate_options({"word": "zzqqxx"}) is None
    assert "letters" in hangman.validate_options({"word": "a"})
    assert "letters" in hangman.validate_options({"word": "a" * 30})
    assert hangman.validate_options({"word": "abc123"}) is not None


def _playing(word="balloon", guessed=None, wrong_letters=None, status="playing"):
    return {
        "word": word,
        "guessed": guessed or [],
        "wrong_letters": wrong_letters or [],
        "difficulty": "medium",
        "status": status,
        "max_wrong": 6,
    }


def test_correct_guess_fills_in_without_counting_as_wrong():
    state, events = hangman.handle_action(_playing(), "p1", "ANA", "guess_letter", {"letter": "b"})
    assert state["guessed"] == ["b"]
    assert state["wrong_letters"] == []
    assert state["status"] == "playing"
    assert events[0] == {"kind": "letter_guess", "name": "ANA", "letter": "b", "correct": True}


def test_wrong_guess_recorded():
    state, events = hangman.handle_action(_playing(), "p1", "ANA", "guess_letter", {"letter": "z"})
    assert state["wrong_letters"] == ["z"]
    assert state["status"] == "playing"
    assert events[0]["correct"] is False


def test_already_guessed_letter_rejected_state_unchanged():
    base = _playing(guessed=["b"])
    state, events = hangman.handle_action(base, "p1", "ANA", "guess_letter", {"letter": "b"})
    assert state is base
    assert events[0] == {"kind": "invalid", "reason": "already_guessed", "letter": "b"}


def test_invalid_letter_rejected():
    base = _playing()
    state, events = hangman.handle_action(base, "p1", "ANA", "guess_letter", {"letter": "ab"})
    assert state is base and events[0]["reason"] == "invalid_letter"
    state, events = hangman.handle_action(base, "p1", "ANA", "guess_letter", {"letter": "5"})
    assert state is base and events[0]["reason"] == "invalid_letter"


def test_winning_guess():
    # "balloon"'s letters: b a l o n — guess all but the last one first.
    guessed = ["b", "a", "l", "o"]
    state, events = hangman.handle_action(
        _playing(guessed=guessed), "p1", "ANA", "guess_letter", {"letter": "n"}
    )
    assert state["status"] == "won"
    win_ev = next(e for e in events if e["kind"] == "win")
    assert win_ev["word"] == "balloon" and win_ev["name"] == "ANA"


def test_losing_after_max_wrong_guesses_emits_lose_once():
    state = _playing(wrong_letters=["x", "y", "z", "q", "w"])  # 5 wrong so far, max_wrong=6
    state, events = hangman.handle_action(state, "p1", "BOB", "guess_letter", {"letter": "v"})
    assert state["status"] == "lost"
    assert any(e["kind"] == "lose" for e in events)
    assert next(e for e in events if e["kind"] == "lose")["answer"] == "balloon"

    # A further wrong guess while already lost must NOT re-emit "lose".
    state2, events2 = hangman.handle_action(state, "p1", "BOB", "guess_letter", {"letter": "k"})
    assert state2["status"] == "lost"
    assert not any(e["kind"] == "lose" for e in events2)


def test_is_finished_excludes_lost():
    lost = _playing(status="lost")
    assert hangman.is_finished(lost) is False
    assert hangman.is_finished(_playing(status="won")) is True
    assert hangman.is_finished(_playing(status="revealed")) is True
    assert hangman.is_finished(_playing(status="playing")) is False


def test_can_keep_guessing_and_win_after_losing():
    # Already lost (gallows full), but the remaining letters can still be guessed to win.
    lost = _playing(guessed=["b", "a", "l"], wrong_letters=["x"] * 6, status="lost")
    state, events = hangman.handle_action(lost, "p1", "ANA", "guess_letter", {"letter": "o"})
    assert state["status"] == "lost"  # not won yet — "n" still missing
    state, events = hangman.handle_action(state, "p1", "ANA", "guess_letter", {"letter": "n"})
    assert state["status"] == "won"
    assert any(e["kind"] == "win" for e in events)


def test_no_guess_letter_once_finished():
    won = _playing(status="won")
    state, events = hangman.handle_action(won, "p1", "ANA", "guess_letter", {"letter": "z"})
    assert state is won
    assert events[0]["reason"] == "finished"


def test_reveal_rejected_unless_lost():
    playing = _playing(status="playing")
    state, events = hangman.handle_action(playing, "p1", "ANA", "reveal", {})
    assert state is playing
    assert events[0]["reason"] == "not_lost"

    won = _playing(status="won")
    state, events = hangman.handle_action(won, "p1", "ANA", "reveal", {})
    assert state is won
    assert events[0]["reason"] == "not_lost"


def test_reveal_succeeds_when_lost():
    lost = _playing(status="lost")
    state, events = hangman.handle_action(lost, "p1", "ANA", "reveal", {})
    assert state["status"] == "revealed"
    assert events[0] == {"kind": "revealed", "name": "ANA", "word": "balloon"}


def test_snapshot_masked_word_and_word_visibility():
    snap = hangman.snapshot(_playing(guessed=["b", "a"]))
    assert snap["maskedWord"] == "ba_____" == "ba" + "_" * 5
    assert snap["word"] is None  # still playing

    lost = _playing(guessed=["b", "a"], wrong_letters=["x"] * 6, status="lost")
    snap = hangman.snapshot(lost)
    assert snap["word"] is None  # lost is NOT finished — still hidden

    won = _playing(guessed=list("balloon"), status="won")
    snap = hangman.snapshot(won)
    assert snap["word"] == "balloon"

    revealed = _playing(status="revealed")
    snap = hangman.snapshot(revealed)
    assert snap["word"] == "balloon"


def test_snapshot_wrong_count_caps_at_max_wrong():
    state = _playing(wrong_letters=["a", "b", "c", "d", "e", "f", "g"])  # 7 > max_wrong=6
    snap = hangman.snapshot(state)
    assert snap["wrongCount"] == 6
    assert snap["maxGuesses"] == 6


def test_result():
    won = _playing(guessed=["b", "a"], status="won")
    res = hangman.result(won)
    assert res == {"won": True, "answer": "balloon", "guesses_used": 2}

    revealed = _playing(guessed=["b"], status="revealed")
    assert hangman.result(revealed)["won"] is False
