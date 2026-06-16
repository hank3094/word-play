"""Tests for the Redis-backed live state, run against fakeredis."""

import pytest

from games import redis_client, state
from games.gametypes import wordle


@pytest.fixture(autouse=True)
async def _clean():
    await redis_client.reset_client()  # fresh fakeredis datastore per test
    await state.reset()
    yield
    await state.reset()


@pytest.fixture
def fixed_answer(monkeypatch):
    monkeypatch.setattr(wordle, "pick_word", lambda: "crane")
    return "crane"


async def test_register_and_players_snapshot():
    await state.register("p1", "ANA")
    await state.register("p2", "BOB")
    names = {p["name"] for p in await state.players_snapshot()}
    assert names == {"ANA", "BOB"}


async def test_unregister_removes_player():
    await state.register("p1", "ANA")
    await state.unregister("p1")
    assert await state.players_snapshot() == []


async def test_multiple_connections_count_as_one_player():
    # Same stable id connecting twice (e.g. a refresh overlap, or a second tab) is one presence
    # entry, and survives one of the connections going away.
    await state.register("cid1", "ANA")
    await state.register("cid1", "ANA")
    assert [p["name"] for p in await state.players_snapshot()] == ["ANA"]
    await state.unregister("cid1")  # one connection drops...
    assert [p["name"] for p in await state.players_snapshot()] == ["ANA"]  # ...still present
    await state.unregister("cid1")  # last connection drops
    assert await state.players_snapshot() == []


async def test_create_and_list_game(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    games = await state.list_games()
    assert len(games) == 1
    assert games[0]["id"] == gid
    assert games[0]["gameType"] == "wordle"
    assert games[0]["count"] == 1


async def test_create_unknown_game_type_returns_none():
    assert await state.create_game("chess", "p1", "ANA") is None


async def test_join_and_leave_game(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    snap = await state.join_game("p2", gid, "BOB")
    assert {p["name"] for p in snap["players"]} == {"ANA", "BOB"}
    await state.leave_game("p2", gid)
    snap2 = await state.game_snapshot(gid)
    assert {p["name"] for p in snap2["players"]} == {"ANA"}


async def test_create_game_with_custom_word():
    gid = await state.create_game("wordle", "p1", "ANA", {"word": "crane"})
    res = await state.apply_action(gid, "p1", "ANA", "guess", {"word": "crane"})
    assert res["finished"] and res["result"]["won"] and res["result"]["answer"] == "crane"


def test_validate_new_game():
    assert state.validate_new_game("wordle", {}) is None
    assert state.validate_new_game("wordle", {"word": "crane"}) is None
    assert state.validate_new_game("wordle", {"word": "zzzzz"})  # error string
    assert state.validate_new_game("chess", {}) == "Unknown game type."


async def test_create_records_owner(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    games = await state.list_games()
    assert games[0]["owner"] == "p1"
    snap = await state.game_snapshot(gid)
    assert snap["owner"] == "p1"


async def test_owner_can_delete_game(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    assert await state.delete_game("p1", gid) is True
    assert await state.list_games() == []
    assert await state.game_snapshot(gid) is None


async def test_non_owner_cannot_delete_game(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    await state.join_game("p2", gid, "BOB")
    assert await state.delete_game("p2", gid) is False
    assert len(await state.list_games()) == 1


async def test_delete_missing_game_is_noop():
    assert await state.delete_game("p1", "nope") is False


async def test_apply_guess_changes_state_and_feed(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    res = await state.apply_action(gid, "p1", "ANA", "guess", {"word": "slate"})
    assert res["ok"] and res["changed"]
    assert not res["finished"]
    snap = res["snapshot"]
    assert len(snap["board"]["rows"]) == 1
    assert snap["feed"][-1]["kind"] == "guess"
    # answer stays hidden while playing
    assert snap["board"]["answer"] is None


async def test_apply_typing_is_transient(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    res = await state.apply_action(gid, "p1", "ANA", "typing", {"text": "cra"})
    assert res["ok"]
    assert res["changed"] is False
    assert res["events"][0]["kind"] == "typing"
    snap = await state.game_snapshot(gid)
    assert snap["board"]["rows"] == []  # no board change persisted


async def test_apply_invalid_guess_rejected(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    res = await state.apply_action(gid, "p1", "ANA", "guess", {"word": "zzzzz"})
    assert res["ok"] is False and res["changed"] is False


async def test_winning_guess_finishes_and_returns_result(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    res = await state.apply_action(gid, "p1", "ANA", "guess", {"word": "crane"})
    assert res["finished"] is True
    assert res["result"]["won"] is True
    assert res["result"]["answer"] == "crane"
    assert res["result"]["players"] == ["ANA"]
    # the finished snapshot reveals the answer
    assert res["snapshot"]["board"]["answer"] == "crane"


async def test_set_name_updates_game_membership(fixed_answer):
    gid = await state.create_game("wordle", "p1", "ANA")
    affected = await state.set_name("p1", "ANNA")
    assert gid in affected
    snap = await state.game_snapshot(gid)
    assert snap["players"][0]["name"] == "ANNA"
