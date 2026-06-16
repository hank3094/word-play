#!/bin/sh
# Apply migrations, then serve the ASGI app (HTTP + WebSockets) with Daphne.
set -e

python manage.py migrate --noinput
exec daphne -b 0.0.0.0 -p "${PORT:-8000}" wordplay.asgi:application
