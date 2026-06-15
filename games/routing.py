"""WebSocket URL routing for Channels."""

from django.urls import re_path

from .consumers import PlayConsumer

websocket_urlpatterns = [
    re_path(r"^ws/play/$", PlayConsumer.as_asgi()),
]
