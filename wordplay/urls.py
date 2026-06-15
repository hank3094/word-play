"""Root URL configuration: the SPA shell plus the JSON API under /api/."""

from django.urls import include, path

from games import views

urlpatterns = [
    path("", views.index),
    path("api/", include("games.urls")),
]
