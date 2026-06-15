"""Django settings for the WORD PLAY project.

Serves the SPA page, a small JSON API, and cooperative multiplayer WebSockets (Django Channels /
ASGI). Live game + presence state lives in Redis (also the Channels layer); finished games persist
to SQLite. Designed for the dev ``runserver`` (Daphne-backed) or a Docker container behind Daphne;
intended for localhost / a trusted VPN, not the public internet.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("WORD_PLAY_SECRET_KEY", "dev-insecure-key-not-for-production")
DEBUG = os.environ.get("WORD_PLAY_DEBUG", "1") == "1"
# Default to "*" so the app works on a VPN / arbitrary hosts. Override via
# WORD_PLAY_ALLOWED_HOSTS (comma-separated) to tighten.
ALLOWED_HOSTS = os.environ.get("WORD_PLAY_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "daphne",  # must precede staticfiles so its ASGI runserver takes over
    "channels",
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "games",
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]
# In production (DEBUG off) WhiteNoise serves the collected static files. In dev, Django's
# staticfiles app serves them, so WhiteNoise is left out (avoids a missing-STATIC_ROOT warning).
if not DEBUG:
    MIDDLEWARE.insert(0, "whitenoise.middleware.WhiteNoiseMiddleware")

ROOT_URLCONF = "wordplay.urls"
ASGI_APPLICATION = "wordplay.asgi.application"
WSGI_APPLICATION = "wordplay.wsgi.application"

# --- Redis / Channels ----------------------------------------------------------------------------
# Redis is both the Channels layer AND the authoritative live-state store (see games/state.py).
# REDIS_URL points at the broker; in automated tests we avoid an external Redis entirely:
#   WORD_PLAY_FAKE_REDIS=1        -> state.py uses fakeredis.aioredis
#   WORD_PLAY_CHANNEL_LAYER=memory -> InMemoryChannelLayer (single in-process worker)
REDIS_URL = os.environ.get("WORD_PLAY_REDIS_URL", "redis://127.0.0.1:6379/0")
FAKE_REDIS = os.environ.get("WORD_PLAY_FAKE_REDIS", "0") == "1"

if os.environ.get("WORD_PLAY_CHANNEL_LAYER", "redis") == "memory" or FAKE_REDIS:
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL]},
        }
    }

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "frontend" / "templates"],
        "APP_DIRS": False,
        "OPTIONS": {"context_processors": []},
    },
]

# SQLite file location. WORD_PLAY_DB_PATH is for deployment (a mounted volume); WORD_PLAY_E2E_DB is
# set by the Playwright harness so tests never touch the real db.sqlite3.
_DB_NAME = (
    os.environ.get("WORD_PLAY_DB_PATH")
    or os.environ.get("WORD_PLAY_E2E_DB")
    or (BASE_DIR / "db.sqlite3")
)

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": _DB_NAME,
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "frontend" / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"
# In production (DEBUG off) WhiteNoise serves hashed, compressed static via the manifest built by
# collectstatic. In dev the manifest doesn't exist, so fall back to plain storage.
_STATIC_BACKEND = (
    "django.contrib.staticfiles.storage.StaticFilesStorage"
    if DEBUG
    else "whitenoise.storage.CompressedManifestStaticFilesStorage"
)
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": _STATIC_BACKEND},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
