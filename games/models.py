"""Persistent records. Live game/presence state lives in Redis; only *finished* games are saved
here, for a simple cross-session history / leaderboard.
"""

from django.db import models


class FinishedGame(models.Model):
    game_type = models.CharField(max_length=32, default="wordle")
    answer = models.CharField(max_length=32, blank=True)
    won = models.BooleanField(default=False)
    guesses_used = models.PositiveSmallIntegerField(default=0)
    player_names = models.CharField(max_length=200, blank=True)  # comma-joined participant names
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        outcome = "won" if self.won else "lost"
        return f"{self.game_type} {outcome} ({self.answer})"
