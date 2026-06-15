"""Settings used by the pytest suite.

Forces the dependency-free backends (fakeredis live state + in-memory channel layer) explicitly, so
the unit/consumer tests never need an external Redis and don't depend on environment-variable load
order. The Playwright e2e suite runs a real ``runserver`` with its own env instead.
"""

from wordplay.settings import *  # noqa: F401,F403

FAKE_REDIS = True
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
