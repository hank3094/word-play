"""Tests for the small read-only JSON API."""

import pytest

from games.models import FinishedGame


def test_healthz(client):
    resp = client.get("/api/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_game_types(client):
    resp = client.get("/api/game-types")
    assert resp.status_code == 200
    keys = {g["key"] for g in resp.json()["gameTypes"]}
    assert "wordle" in keys


@pytest.mark.django_db
def test_history_lists_finished_games(client):
    FinishedGame.objects.create(
        game_type="wordle", answer="crane", won=True, guesses_used=3, player_names="ANA,BOB"
    )
    resp = client.get("/api/history")
    assert resp.status_code == 200
    rows = resp.json()["history"]
    assert len(rows) == 1
    assert rows[0]["answer"] == "crane"
    assert rows[0]["won"] is True
    assert rows[0]["players"] == ["ANA", "BOB"]


def test_index_renders(client):
    resp = client.get("/")
    assert resp.status_code == 200
