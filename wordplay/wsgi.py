"""WSGI config (kept for parity; the app is served over ASGI/Daphne in practice)."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "wordplay.settings")

application = get_wsgi_application()
