"""Root URL configuration: the SPA shell plus the JSON API under /api/."""

from django.urls import include, path

from games import views

urlpatterns = [
    path("", views.index),
    # A static, shareable link straight to one game (see frontend/static/js/app.js's URL routing).
    path("g/<str:gid>", views.index),
    path("api/", include("games.urls")),
]
