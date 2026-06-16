"""Unit tests for the pure cooperative-Wordle rules."""

from games.gametypes import wordle


def test_all_hits_when_guess_matches():
    assert wordle.score_guess("crane", "crane") == ["hit"] * 5


def test_present_and_miss():
    # answer c r a n e ; guess e n a c t
    assert wordle.score_guess("enact", "crane") == [
        "present",
        "present",
        "hit",
        "present",
        "miss",
    ]


def test_duplicate_letters_limited_to_answer_count():
    # "apple" has two p's; extra p's in the guess stay "miss" once the count is used up.
    assert wordle.score_guess("ppppp", "apple") == [
        "miss",
        "hit",
        "hit",
        "miss",
        "miss",
    ]


def test_duplicate_guess_letter_one_present_one_miss():
    # answer "abide" has a single e; guess "eerie" -> the final e is a hit, the two leading e's
    # have no remaining count so stay miss (the i is a present).
    marks = wordle.score_guess("eerie", "abide")
    assert marks == ["miss", "miss", "miss", "present", "hit"]


def test_is_allowed():
    assert wordle.is_allowed("crane")
    assert wordle.is_allowed("CRANE")  # case-insensitive
    assert not wordle.is_allowed("zzzzz")


def test_pick_word_is_a_valid_answer():
    w = wordle.pick_word()
    assert len(w) == wordle.WORD_LENGTH
    assert w in wordle.answers() if hasattr(wordle, "answers") else True
    assert wordle.is_allowed(w)


def test_create_state_uses_valid_custom_word():
    state = wordle.create_state({"word": "Crane"})
    assert state["answer"] == "crane"


def test_create_state_falls_back_to_random_for_bad_word():
    state = wordle.create_state({"word": "zzzzz"})
    assert state["answer"] != "zzzzz"
    assert wordle.is_allowed(state["answer"])


def test_create_state_random_when_no_word():
    assert wordle.is_allowed(wordle.create_state()["answer"])
    assert wordle.is_allowed(wordle.create_state({})["answer"])


def test_validate_options():
    assert wordle.validate_options({}) is None
    assert wordle.validate_options({"word": ""}) is None
    assert wordle.validate_options({"word": "crane"}) is None
    assert "5 letters" in wordle.validate_options({"word": "cat"})
    assert "word list" in wordle.validate_options({"word": "zzzzz"})


def _playing(answer="crane", rows=None):
    return {"answer": answer, "rows": rows or [], "status": "playing"}


def test_guess_appends_row_and_keeps_playing():
    state, events = wordle.handle_action(_playing(), "p1", "ANA", "guess", {"word": "slate"})
    assert state["status"] == "playing"
    assert len(state["rows"]) == 1
    assert state["rows"][0]["by"] == "ANA"
    assert events[0]["kind"] == "guess"


def test_winning_guess():
    state, events = wordle.handle_action(_playing(), "p1", "ANA", "guess", {"word": "crane"})
    assert state["status"] == "won"
    assert any(e["kind"] == "win" for e in events)


def test_losing_after_max_guesses():
    rows = [{"by": "X", "word": "slate", "marks": ["miss"] * 5} for _ in range(5)]
    state, events = wordle.handle_action(
        _playing(rows=rows), "p1", "BOB", "guess", {"word": "moldy"}
    )
    assert state["status"] == "lost"
    assert any(e["kind"] == "lose" for e in events)
    assert events[-1]["answer"] == "crane"


def test_invalid_length_and_unknown_word_dont_change_state():
    base = _playing()
    s1, e1 = wordle.handle_action(base, "p1", "ANA", "guess", {"word": "ab"})
    assert s1 is base and e1[0]["reason"] == "length"
    s2, e2 = wordle.handle_action(base, "p1", "ANA", "guess", {"word": "zzzzz"})
    assert s2 is base and e2[0]["reason"] == "unknown"


def test_typing_is_transient_no_state_change():
    base = _playing()
    state, events = wordle.handle_action(base, "p1", "ANA", "typing", {"text": "cra"})
    assert state is base
    assert events[0] == {"kind": "typing", "pid": "p1", "name": "ANA", "text": "cra"}


def test_no_actions_once_finished():
    won = {"answer": "crane", "rows": [], "status": "won"}
    state, events = wordle.handle_action(won, "p1", "ANA", "guess", {"word": "slate"})
    assert state is won
    assert events[0]["reason"] == "finished"


def test_snapshot_hides_answer_until_finished():
    snap = wordle.snapshot(_playing())
    assert snap["answer"] is None
    won = {"answer": "crane", "rows": [], "status": "won"}
    assert wordle.snapshot(won)["answer"] == "crane"


def test_keyboard_hints_take_best_state():
    rows = [
        {"by": "X", "word": "crane", "marks": ["miss", "present", "miss", "miss", "miss"]},
        {"by": "X", "word": "round", "marks": ["hit", "miss", "miss", "miss", "miss"]},
    ]
    hints = wordle.keyboard_hints({"answer": "x", "rows": rows, "status": "playing"})
    assert hints["r"] == "hit"  # upgraded from present -> hit
    assert hints["c"] == "miss"
