"""Async tests for the cooperative WebSocket consumer.

Run against the in-memory channel layer + fakeredis state (see wordplay/settings_test.py), so no
external services are needed. ``transaction=True`` because finishing a game writes a FinishedGame
row from a worker thread via ``database_sync_to_async``.
"""

import pytest
from channels.testing import WebsocketCommunicator

from games import redis_client, state
from games.consumers import PlayConsumer
from games.gametypes import hangman, wordle
from games.models import FinishedGame

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
async def _clean():
    await redis_client.reset_client()
    await state.reset()
    yield
    await state.reset()


@pytest.fixture
def fixed_answer(monkeypatch):
    monkeypatch.setattr(wordle, "pick_word", lambda word_length=5: "crane")
    return "crane"


@pytest.fixture
def fixed_hangman_word(monkeypatch):
    monkeypatch.setattr(hangman, "pick_word", lambda difficulty="medium": "cat")
    return "cat"


async def _connect(name, cid=None):
    comm = WebsocketCommunicator(PlayConsumer.as_asgi(), "/ws/play/")
    connected, _ = await comm.connect()
    assert connected
    hello = {"type": "hello", "name": name}
    if cid:
        hello["cid"] = cid
    await comm.send_json_to(hello)
    return comm


async def _recv_until(comm, mtype, tries=15):
    for _ in range(tries):
        msg = await comm.receive_json_from(timeout=2)
        if msg.get("type") == mtype:
            return msg
    raise AssertionError(f"did not receive a {mtype!r} message")


async def test_two_clients_see_each_other_in_lobby():
    a = await _connect("ANA")
    b = await _connect("BOB")
    try:
        lobby = await _recv_until(b, "lobby")
        assert {p["name"] for p in lobby["players"]} >= {"ANA", "BOB"}
    finally:
        await a.disconnect()
        await b.disconnect()


async def test_create_open_typing_and_guess_broadcast(fixed_answer):
    a = await _connect("ANA")
    b = await _connect("BOB")
    try:
        # ANA creates a game and is dropped into it.
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})
        game_a = await _recv_until(a, "game")
        gid = game_a["snapshot"]["id"]
        assert game_a["snapshot"]["gameType"] == "wordle"

        # BOB sees it in the lobby and opens it.
        lobby_b = await _recv_until(b, "lobby")
        assert any(g["id"] == gid for g in lobby_b["games"])
        await b.send_json_to({"type": "open_game", "gameId": gid})
        game_b = await _recv_until(b, "game")
        assert {p["name"] for p in game_b["snapshot"]["players"]} == {"ANA", "BOB"}

        # ANA's live typing reaches BOB as a transient feed event.
        await a.send_json_to(
            {"type": "game_action", "gameId": gid, "action": "typing", "data": {"text": "cra"}}
        )
        feed = await _recv_until(b, "feed")
        assert feed["event"]["kind"] == "typing"
        assert feed["event"]["name"] == "ANA"
        assert feed["event"]["text"] == "cra"

        # A real guess updates the shared board for both players.
        await a.send_json_to(
            {"type": "game_action", "gameId": gid, "action": "guess", "data": {"word": "slate"}}
        )
        snap_b = await _recv_until(b, "game")
        assert len(snap_b["snapshot"]["board"]["rows"]) == 1
        assert snap_b["snapshot"]["board"]["rows"][0]["by"] == "ANA"
    finally:
        await a.disconnect()
        await b.disconnect()


async def test_create_with_custom_word():
    a = await _connect("ANA")
    try:
        await a.send_json_to(
            {"type": "create_game", "gameType": "wordle", "options": {"word": "ghost"}}
        )
        game = await _recv_until(a, "game")
        gid = game["snapshot"]["id"]
        # the chosen word is the answer: guessing it wins
        await a.send_json_to(
            {"type": "game_action", "gameId": gid, "action": "guess", "data": {"word": "ghost"}}
        )
        won = await _recv_until(a, "game")
        assert won["snapshot"]["status"] == "won"
        assert won["snapshot"]["board"]["answer"] == "ghost"
    finally:
        await a.disconnect()


async def test_create_with_invalid_word_errors_and_makes_no_game():
    a = await _connect("ANA")
    try:
        await a.send_json_to(
            {"type": "create_game", "gameType": "wordle", "options": {"word": "zzzzz"}}
        )
        err = await _recv_until(a, "create_error")
        assert "word list" in err["error"]
        assert await state.list_games() == []  # nothing was created
    finally:
        await a.disconnect()


async def test_winning_guess_writes_finished_game(fixed_answer):
    a = await _connect("ANA")
    try:
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})
        game = await _recv_until(a, "game")
        gid = game["snapshot"]["id"]

        await a.send_json_to(
            {"type": "game_action", "gameId": gid, "action": "guess", "data": {"word": "crane"}}
        )
        won = await _recv_until(a, "game")
        assert won["snapshot"]["status"] == "won"
        assert won["snapshot"]["board"]["answer"] == "crane"

        count = await _finished_count()
        assert count == 1
    finally:
        await a.disconnect()


async def test_rejected_guess_only_notifies_sender(fixed_answer):
    a = await _connect("ANA")
    try:
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})
        game = await _recv_until(a, "game")
        gid = game["snapshot"]["id"]
        await a.send_json_to(
            {"type": "game_action", "gameId": gid, "action": "guess", "data": {"word": "zzzzz"}}
        )
        rejected = await _recv_until(a, "rejected")
        assert rejected["reason"] == "unknown"
    finally:
        await a.disconnect()


async def test_hangman_win_without_guess_event_does_not_crash(fixed_hangman_word):
    # Hangman's routine event kind is "letter_guess", not "guess" — so a hangman win has a
    # win_ev with no co-occurring guess_ev, the exact case the old consumers.py code (direct
    # `guess_ev["word"]` indexing nested inside `if guess_ev:`) would have crashed on.
    a = await _connect("ANA")
    try:
        await a.send_json_to({"type": "create_game", "gameType": "hangman"})
        game = await _recv_until(a, "game")
        gid = game["snapshot"]["id"]
        assert game["snapshot"]["gameType"] == "hangman"

        for letter in "ca":
            await a.send_json_to(
                {
                    "type": "game_action",
                    "gameId": gid,
                    "action": "guess_letter",
                    "data": {"letter": letter},
                }
            )
            await _recv_until(a, "game")

        # The final letter wins. The activity broadcast happens before the game-snapshot one.
        await a.send_json_to(
            {
                "type": "game_action",
                "gameId": gid,
                "action": "guess_letter",
                "data": {"letter": "t"},
            }
        )
        activity = await _recv_until(a, "activity_event")
        assert activity["event"]["kind"] == "game_won"
        assert activity["event"]["word"] == "cat"
        assert activity["event"].get("marks") is None  # no Wordle-style marks for hangman

        won = await _recv_until(a, "game")
        assert won["snapshot"]["status"] == "won"
        assert won["snapshot"]["board"]["word"] == "cat"
    finally:
        await a.disconnect()


async def test_hangman_letter_guess_lands_in_feed_and_global_activity(fixed_hangman_word):
    a = await _connect("ANA")
    try:
        await a.send_json_to({"type": "create_game", "gameType": "hangman"})
        game = await _recv_until(a, "game")
        gid = game["snapshot"]["id"]

        await a.send_json_to(
            {
                "type": "game_action",
                "gameId": gid,
                "action": "guess_letter",
                "data": {"letter": "z"},
            }
        )
        # The activity broadcast happens before the game-snapshot one (same ordering as Wordle).
        activity = await _recv_until(a, "activity_event")
        assert activity["event"]["kind"] == "letter_guess"
        assert activity["event"]["letter"] == "z"
        assert activity["event"]["correct"] is False

        snap = await _recv_until(a, "game")
        assert snap["snapshot"]["board"]["wrongCount"] == 1
        assert snap["snapshot"]["feed"][-1]["kind"] == "letter_guess"
    finally:
        await a.disconnect()


async def test_owner_deletes_game_and_member_is_bounced(fixed_answer):
    a = await _connect("ANA", cid="cid-ana")  # owner
    b = await _connect("BOB", cid="cid-bob")
    try:
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})
        gid = (await _recv_until(a, "game"))["snapshot"]["id"]
        await b.send_json_to({"type": "open_game", "gameId": gid})
        await _recv_until(b, "game")

        # A non-owner delete is ignored: the game stays in the lobby.
        await b.send_json_to({"type": "delete_game", "gameId": gid})
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})  # force a lobby tick
        await _recv_until(a, "game")
        lobby = await _recv_until(a, "lobby")
        assert any(g["id"] == gid for g in lobby["games"])

        # The owner deletes it: BOB (a member) is bounced, and it leaves the lobby.
        await a.send_json_to({"type": "delete_game", "gameId": gid})
        closed = await _recv_until(b, "game_closed")
        assert closed["gameId"] == gid
        lobby2 = await _recv_until(a, "lobby")
        assert not any(g["id"] == gid for g in lobby2["games"])
    finally:
        await a.disconnect()
        await b.disconnect()


async def test_owner_in_game_deletes_and_is_bounced_too(fixed_answer):
    # When the owner deletes a game while they are still inside it (the common
    # case: clicking DELETE in the game view), they must also receive game_closed
    # and be returned to the lobby — not left stranded in the game view.
    a = await _connect("ANA", cid="cid-ana")  # owner, stays in game
    b = await _connect("BOB", cid="cid-bob")  # member
    try:
        await a.send_json_to({"type": "create_game", "gameType": "wordle"})
        gid = (await _recv_until(a, "game"))["snapshot"]["id"]
        await b.send_json_to({"type": "open_game", "gameId": gid})
        await _recv_until(b, "game")

        # ANA is still in the game (current_game == gid on the server side).
        # Deleting it should bounce both ANA and BOB.
        await a.send_json_to({"type": "delete_game", "gameId": gid})
        closed_a = await _recv_until(a, "game_closed")
        closed_b = await _recv_until(b, "game_closed")
        assert closed_a["gameId"] == gid
        assert closed_b["gameId"] == gid
    finally:
        await a.disconnect()
        await b.disconnect()


async def test_same_client_id_is_one_player_and_survives_one_drop():
    # Two connections sharing a stable client id (a refresh overlap / second tab) are one player;
    # closing one keeps the player present.
    a1 = await _connect("ANA", cid="cid-ana")
    a2 = await _connect("ANA", cid="cid-ana")
    b = await _connect("BOB")
    try:
        lobby = await _recv_until(b, "lobby")
        anas = [p for p in lobby["players"] if p["name"] == "ANA"]
        assert len(anas) == 1
        await a1.disconnect()  # one of ANA's connections drops
        lobby2 = await _recv_until(b, "lobby")
        assert "ANA" in {p["name"] for p in lobby2["players"]}  # still here
    finally:
        await a2.disconnect()
        await b.disconnect()


async def test_disconnect_removes_from_lobby():
    a = await _connect("ANA")
    b = await _connect("BOB")
    try:
        await _recv_until(b, "lobby")
        await a.disconnect()
        lobby = await _recv_until(b, "lobby")
        assert "ANA" not in {p["name"] for p in lobby["players"]}
    finally:
        await b.disconnect()


from channels.db import database_sync_to_async  # noqa: E402


@database_sync_to_async
def _finished_count():
    return FinishedGame.objects.count()
