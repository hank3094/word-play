"""Persistent records. Live game/presence state lives in Redis; finished games and the activity
log are saved here for cross-session history.
"""

from django.db import models


class FinishedGame(models.Model):
    game_id = models.CharField(max_length=64, blank=True, db_index=True)
    game_type = models.CharField(max_length=32, default="wordle")
    answer = models.CharField(max_length=32, blank=True)
    won = models.BooleanField(default=False)
    guesses_used = models.PositiveSmallIntegerField(default=0)
    player_names = models.CharField(max_length=200, blank=True)  # comma-joined participant names
    created_at = models.DateTimeField(auto_now_add=True)
    snapshot = models.JSONField(null=True, blank=True)  # full game state for later review

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        outcome = "won" if self.won else "lost"
        return f"{self.game_type} {outcome} ({self.answer})"


class ActivityEvent(models.Model):
    """One entry in the global activity log, kept forever."""

    ts = models.FloatField(db_index=True)
    event_id = models.CharField(max_length=12, unique=True)
    data = models.JSONField()  # full event dict as sent to the frontend

    class Meta:
        ordering = ["-ts"]

    def __str__(self):
        return f"{self.data.get('kind', '?')} @ {self.ts}"
