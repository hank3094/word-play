# WORD PLAY container: Django + Channels served by Daphne (ASGI), static via WhiteNoise.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

# uv for fast, reproducible installs from uv.lock.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# Install dependencies first (cached unless the lock changes).
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen

# App source.
COPY . .

# Collect static with DEBUG off so WhiteNoise's manifest (staticfiles.json) is built.
RUN WORD_PLAY_DEBUG=0 python manage.py collectstatic --noinput

RUN chmod +x docker/entrypoint.sh
EXPOSE 8000
CMD ["docker/entrypoint.sh"]
