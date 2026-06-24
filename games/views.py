"""HTTP surface: the SPA shell plus a tiny read-only JSON API.

All realtime gameplay happens over the WebSocket (see consumers.py); these endpoints only serve the
page, a health check for the container, the finished-game history, and the list of game types.
"""

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_http_methods

from .gametypes import game_type_list
from .models import FinishedGame


@require_http_methods(["GET"])
def index(request, gid=None):
    # ``gid`` (from the /g/<gid> share link) is read client-side from the URL, not here — this
    # route just needs to serve the same SPA shell instead of 404ing.
    return render(request, "index.html")


@require_http_methods(["GET"])
def healthz(request):
    return JsonResponse({"ok": True})


@require_http_methods(["GET"])
def history(request):
    rows = FinishedGame.objects.all()[:20]
    return JsonResponse(
        {
            "history": [
                {
                    "gameId": r.game_id,
                    "gameType": r.game_type,
                    "answer": r.answer,
                    "won": r.won,
                    "guessesUsed": r.guesses_used,
                    "maxGuesses": (
                        r.snapshot["board"].get("maxGuesses", 6)
                        if r.snapshot and "board" in r.snapshot
                        else 6
                    ),
                    "players": r.player_names.split(",") if r.player_names else [],
                    "at": r.created_at.isoformat(),
                    "hasSnapshot": r.snapshot is not None,
                }
                for r in rows
            ]
        }
    )


@require_http_methods(["GET"])
def game_types(request):
    return JsonResponse({"gameTypes": game_type_list()})
