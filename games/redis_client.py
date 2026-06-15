"""Lazy singleton async Redis client.

Real Redis in production; an in-process ``fakeredis`` when ``WORD_PLAY_FAKE_REDIS=1`` (unit tests
and the Playwright e2e harness), so neither the app nor its tests need an external Redis to run.
``decode_responses=True`` so values come back as ``str``.
"""

from __future__ import annotations

from django.conf import settings

_client = None


def get_client():
    global _client
    if _client is None:
        if getattr(settings, "FAKE_REDIS", False):
            import fakeredis.aioredis

            _client = fakeredis.aioredis.FakeRedis(decode_responses=True)
        else:
            import redis.asyncio as aioredis

            _client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _client


async def reset_client() -> None:
    """Drop the cached client (used between tests)."""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
    _client = None
