"""JSON API routes (mounted under /api/). No trailing slashes."""

from django.urls import path

from . import views

urlpatterns = [
    path("healthz", views.healthz),
    path("history", views.history),
    path("game-types", views.game_types),
]
