"""ASGI config: HTTP (Django) + WebSocket (Channels) for cooperative multiplayer.

WebSocket origin validation is intentionally *not* applied — the deployment brief is a trusted VPN
that should accept any connection. Wrap the URLRouter in ``AllowedHostsOriginValidator`` here to
tighten it later.
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "wordplay.settings")

# Initialise Django (and its app registry) before importing anything that touches models/consumers.
django_asgi_app = get_asgi_application()

from games.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": URLRouter(websocket_urlpatterns),
    }
)
