"""Unit tests for the pure Word-Ladder rules."""

from games.gametypes import wordladder


def _state(
    start="cold",
    end="warm",
    word_length=4,
    edit_mode="substitute",
    entries=None,
    status="playing",
    pid="p1",
    winner_pid=None,
):
    boards = {pid: {"entries": entries}} if entries is not None else {}
    return {
        "start_word": start,
        "end_word": end,
        "word_length": word_length,
        "edit_mode": edit_mode,
        "difficulty": "medium",
        "par_steps": 3,
        "max_rows": 13,
        "boards": boards,
        "winner_pid": winner_pid,
        "status": status,
    }


def test_is_valid_edit_substitution():
    assert wordladder._is_valid_edit("cold", "cord", "substitute") is True
    assert wordladder._is_valid_edit("cold", "cold", "substitute") is False  # same word
    assert wordladder._is_valid_edit("cold", "card", "substitute") is False  # two letters differ
    assert wordladder._is_valid_edit("cold", "cold1", "substitute") is False  # length differs


def test_is_valid_edit_insert_delete_requires_mode():
    assert wordladder._is_valid_edit("cat", "cats", "substitute") is False
    assert wordladder._is_valid_edit("cat", "cats", "insert_delete") is True
    assert wordladder._is_valid_edit("cats", "cat", "insert_delete") is True
    assert wordladder._is_valid_edit("cat", "dogs", "insert_delete") is False  # not one indel


def test_bfs_shortest_path_finds_the_shortcut(monkeypatch):
    # a -> b -> c -> d -> e, but a and d share neighbor "x", a 2-edge shortcut shorter than the
    # 3-edge detour through b and c.
    graph = {
        "a": ("b", "x"),
        "b": ("a", "c"),
        "c": ("b", "d"),
        "d": ("c", "e", "x"),
        "e": ("d",),
        "x": ("a", "d"),
    }
    monkeypatch.setattr(wordladder.wordlists, "ladder_neighbors", lambda length: graph)
    monkeypatch.setattr(wordladder, "_tier_index", lambda word: 0)
    path = wordladder._bfs_shortest_path("a", "e", "substitute", 1, 0)
    assert path == ["a", "x", "d", "e"]


def test_bfs_shortest_path_leaves_a_path_with_no_shortcut_alone():
    path = wordladder._bfs_shortest_path("cold", "warm", "substitute", 4, 1)
    assert path == ["cold", "cord", "card", "ward", "warm"]


def test_bfs_shortest_path_returns_none_when_unreachable(monkeypatch):
    graph = {"a": ("b",), "b": ("a",), "x": ("y",), "y": ("x",)}
    monkeypatch.setattr(wordladder.wordlists, "ladder_neighbors", lambda length: graph)
    monkeypatch.setattr(wordladder, "_tier_index", lambda word: 0)
    assert wordladder._bfs_shortest_path("a", "x", "substitute", 1, 0) is None


def test_pick_a_puzzle_respects_endpoints_length():
    path = wordladder.generate_puzzle(4, 3, "easy", "substitute")
    assert len(path[0]) == 4
    assert len(path[-1]) == 4
    assert len(set(path)) == len(path)  # no repeats


def test_generated_puzzle_always_has_the_requested_step_count():
    # A successful sample can have a shortcut collapsed out of it, which used to be returned
    # as-is even though it was then shorter than the requested step count.
    for steps in (1, 2, 3, 4, 5):
        path = wordladder.generate_puzzle(4, steps, "easy", "substitute")
        assert len(path) == steps + 1


def test_insert_delete_puzzles_always_contain_an_indel_step():
    for _ in range(
        20
    ):  # rejection sampling -- run a few times to catch a stray substitute-only path
        path = wordladder.generate_puzzle(4, 3, "easy", "insert_delete")
        assert wordladder._has_indel_step(path)


def test_validate_options():
    assert wordladder.validate_options({}) is None
    assert wordladder.validate_options({"wordLength": 5, "steps": 4}) is None
    assert wordladder.validate_options({"wordLength": 2}) is not None
    assert wordladder.validate_options({"steps": 99}) is not None
    assert wordladder.validate_options({"difficulty": "impossible"}) is not None
    assert wordladder.validate_options({"editMode": "teleport"}) is not None


def test_create_state_defaults():
    state = wordladder.create_state()
    assert state["status"] == "playing"
    assert state["boards"] == {}  # no player has acted yet
    assert state["winner_pid"] is None
    assert state["word_length"] == wordladder.DEFAULT_LENGTH
    assert len(state["start_word"]) == state["word_length"]
    assert len(state["end_word"]) == state["word_length"]
    assert state["max_rows"] == state["par_steps"] + 10


def test_first_action_creates_a_board_for_that_player_only():
    state = wordladder.create_state({"wordLength": 4})
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert list(new_state["boards"].keys()) == ["p1"]
    assert new_state["boards"]["p1"]["entries"] == [new_state["start_word"], "cord"]


def test_second_player_gets_their_own_independent_board():
    state = _state(entries=["cold", "cord"], pid="p1")
    new_state, _ = wordladder.handle_action(
        state, "p2", "BOB", "set_word", {"index": 1, "word": "bold"}
    )
    assert new_state["boards"]["p1"]["entries"] == ["cold", "cord"]  # untouched
    assert new_state["boards"]["p2"]["entries"] == ["cold", "bold"]


def test_append_row():
    state = _state(entries=["cold"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert new_state["boards"]["p1"]["entries"] == ["cold", "cord"]
    assert events[0] == {"kind": "ladder_step", "name": "ANA", "index": 1, "word": "cord"}


def test_overwrite_middle_row_does_not_truncate():
    # "cart" (not "ward") for the last row -- "ward" is coincidentally one valid edit from the
    # default end word "warm", which would auto-complete the puzzle and defeat this test's point.
    state = _state(entries=["cold", "cord", "card", "cart"])
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "bold"}
    )
    assert new_state["boards"]["p1"]["entries"] == [
        "cold",
        "bold",
        "card",
        "cart",
    ]  # later rows untouched


def test_delete_last_row_with_empty_word():
    state = _state(entries=["cold", "cord", "card"])
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 2, "word": ""}
    )
    assert new_state["boards"]["p1"]["entries"] == ["cold", "cord"]


def test_bad_index_rejected():
    base = _state(entries=["cold"])  # max_rows=13, so valid indices are 1..12
    state, events = wordladder.handle_action(
        base, "p1", "ANA", "set_word", {"index": 20, "word": "cord"}
    )
    assert state is base
    assert events[0]["reason"] == "bad_index"
    state, events = wordladder.handle_action(
        base, "p1", "ANA", "set_word", {"index": 0, "word": "cord"}
    )
    assert state is base and events[0]["reason"] == "bad_index"


def test_max_rows_enforced():
    base = _state(entries=["cold"])
    base["max_rows"] = 1  # only row 0 (the start) fits -- no editable rows at all
    state, events = wordladder.handle_action(
        base, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert state is base
    assert events[0]["reason"] == "bad_index"


def test_skip_ahead_pads_gap_with_blank_rows():
    state = _state(entries=["cold"])
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 3, "word": "card"}
    )
    assert new_state["boards"]["p1"]["entries"] == ["cold", "", "", "card"]
    snap = wordladder.snapshot(new_state)
    assert snap["boards"]["p1"][1] == {"word": "", "isWord": False, "isValidEdit": False}


def test_short_word_outside_generated_lengths_does_not_crash():
    # No ladder_2_*.txt/ladder_graph_2.json is generated (MIN_LENGTH=3 in the graph script) --
    # snapshot must still treat a too-short typed word as simply "not a real word", not crash.
    state = _state(entries=["cold"])
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "zz"}
    )
    snap = wordladder.snapshot(new_state)
    assert snap["boards"]["p1"][1] == {"word": "zz", "isWord": False, "isValidEdit": False}


def test_filling_a_gap_does_not_disturb_later_rows():
    state = _state(entries=["cold", "", "", "card"])
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert new_state["boards"]["p1"]["entries"] == ["cold", "cord", "", "card"]


def test_invalid_word_stored_not_bounced():
    state = _state(entries=["cold"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "zzzz"}
    )
    assert new_state["boards"]["p1"]["entries"] == [
        "cold",
        "zzzz",
    ]  # stored even though not a real word
    snap = wordladder.snapshot(new_state)
    assert snap["boards"]["p1"][1]["isWord"] is False


def test_win_on_reaching_end_word_even_early():
    # par_steps is 3, but a 1-step solution still wins.
    state = _state(start="cold", end="cord", entries=["cold"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert new_state["status"] == "won"
    assert new_state["winner_pid"] == "p1"
    assert any(e["kind"] == "win" for e in events)


def test_not_won_if_an_earlier_row_is_not_a_valid_edit():
    # Row 1 ("cald") is one substitution from both "cold" and end_word "card", but it's
    # gibberish, not a real word -- the chain leading up to end_word is broken, so reaching
    # end_word on the next row must not count as a win.
    state = _state(start="cold", end="card", entries=["cold", "cald"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 2, "word": "card"}
    )
    assert new_state["status"] == "playing"
    assert new_state["winner_pid"] is None
    assert not any(e["kind"] == "win" for e in events)


def test_not_won_if_an_earlier_row_is_blank():
    # Skipping ahead and writing end_word straight into a later row, leaving earlier rows blank,
    # must not count as a win either.
    state = _state(start="cold", end="card", entries=["cold"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 3, "word": "card"}
    )
    assert new_state["status"] == "playing"
    assert new_state["winner_pid"] is None
    assert not any(e["kind"] == "win" for e in events)


def test_auto_completes_when_last_row_is_one_edit_from_end_word():
    # The UI never lets a player type the end word itself into the final ghost row, so the
    # moment their last real row is one valid edit away, end_word is the only possible next
    # move -- it should be appended and the game won, not left "in progress" forever.
    state = _state(start="cold", end="cult", entries=["cold", "colt"])
    new_state, events = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "colt"}
    )
    assert new_state["status"] == "won"
    assert new_state["winner_pid"] == "p1"
    assert new_state["boards"]["p1"]["entries"] == ["cold", "colt", "cult"]
    assert any(e["kind"] == "win" for e in events)


def test_other_players_boards_untouched_and_not_winners_when_someone_else_wins():
    state = _state(start="cold", end="cord", entries=["cold"], pid="p1")
    state["boards"]["p2"] = {"entries": ["cold", "bold"]}
    new_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    assert new_state["winner_pid"] == "p1"
    assert new_state["boards"]["p2"]["entries"] == ["cold", "bold"]  # p2 never touched


def test_no_actions_once_finished():
    won = _state(status="won", entries=["cold", "cord"], winner_pid="p1")
    state, events = wordladder.handle_action(
        won, "p1", "ANA", "set_word", {"index": 2, "word": "card"}
    )
    assert state is won
    assert events[0]["reason"] == "finished"
    # not even a different player can act once the game is frozen
    state, events = wordladder.handle_action(
        won, "p2", "BOB", "set_word", {"index": 1, "word": "cord"}
    )
    assert state is won
    assert events[0]["reason"] == "finished"


def test_snapshot_shows_both_endpoints_always():
    snap = wordladder.snapshot(_state(entries=["cold"]))
    assert snap["startWord"] == "cold"
    assert snap["endWord"] == "warm"
    assert snap["boards"]["p1"][0] == {"word": "cold", "isWord": True, "isValidEdit": True}


def test_snapshot_shows_only_the_winners_board_once_finished():
    state = _state(start="cold", end="cord", entries=["cold"], pid="p1", winner_pid=None)
    state["boards"]["p2"] = {"entries": ["cold", "bold"]}
    won_state, _ = wordladder.handle_action(
        state, "p1", "ANA", "set_word", {"index": 1, "word": "cord"}
    )
    snap = wordladder.snapshot(won_state)
    assert list(snap["boards"].keys()) == ["p1"]
    assert snap["boards"]["p1"] == [
        {"word": "cold", "isWord": True, "isValidEdit": True},
        {"word": "cord", "isWord": True, "isValidEdit": True},
    ]


def test_result():
    won = _state(
        status="won", entries=["cold", "cord", "card", "ward", "warm"], pid="p1", winner_pid="p1"
    )
    res = wordladder.result(won)
    assert res == {"won": True, "answer": "warm", "guesses_used": 4}
