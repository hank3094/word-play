"""Pytest fixtures for the Playwright end-to-end tests.

Spins up the Django dev server against a throwaway SQLite database, using the dependency-free
backends (``WORD_PLAY_FAKE_REDIS=1`` for state, in-memory channel layer) so the suite needs no
external Redis. Torn down afterwards; never touches the real db.sqlite3.
"""

import os
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until_up(url: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url):
                return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError(f"server did not start at {url}")


@pytest.fixture(scope="session")
def server_url() -> Iterator[str]:
    port = _free_port()
    db_path = PROJECT_ROOT / "e2e_test.sqlite3"
    if db_path.exists():
        db_path.unlink()

    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "wordplay.settings",
        "WORD_PLAY_FAKE_REDIS": "1",
        "WORD_PLAY_CHANNEL_LAYER": "memory",
        "WORD_PLAY_E2E_DB": str(db_path),
    }

    subprocess.run(
        [sys.executable, "manage.py", "migrate", "--noinput"],
        cwd=PROJECT_ROOT,
        env=env,
        check=True,
        capture_output=True,
    )

    proc = subprocess.Popen(
        [sys.executable, "manage.py", "runserver", f"127.0.0.1:{port}", "--noreload"],
        cwd=PROJECT_ROOT,
        env=env,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_until_up(base_url + "/api/healthz")
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if db_path.exists():
            db_path.unlink()
