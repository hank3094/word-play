"""Manual verification harness for the zombie-socket guess-retry fix (not part of the regular
suite — exercised once via `uv run pytest tests_e2e/test_zombie_guess_retry.py -v -s`).

Three checks:
1. Normal path: a guess with no failure resolves into a colored row quickly (no regression/delay).
2. Direct fallback: `window.Net.forceRetry` exists and actually closes+reopens the socket (a new
   `page.on("websocket")` connection appears).
3. Best-effort full simulation: drop the network via CDP `Network.emulateNetworkConditions`
   (offline) right as a guess is submitted, hold it offline past the 5s ack timeout, then restore
   it and confirm the guess still lands and a reconnect (new websocket) happened.
"""

import time

import pytest
from playwright.sync_api import Page, expect

_MARKED_TILES_JS = (
    "document.querySelectorAll('#board .tile.hit, #board .tile.present, #board .tile.miss')"
)


def _wait_for_guess_to_land(page: Page, timeout: int) -> None:
    page.wait_for_function(f"{_MARKED_TILES_JS}.length >= 5", timeout=timeout)


def _rows(page: Page) -> int:
    return page.locator("#board .tile.hit, #board .tile.present, #board .tile.miss").count() // 5


def _feed_guess_count(page: Page, word: str) -> int:
    """Count how many times `word` appears as a recorded guess in the activity feed — used to
    detect a double-submission (the same guess landing as two separate feed/board entries)."""
    feed_html = page.locator("#wordle-feed").inner_html().lower()
    return feed_html.count(word.lower())


def _join_and_start_game(page: Page, server_url: str, name: str) -> None:
    page.goto(server_url)
    expect(page.locator("#name-entry")).to_be_visible()
    page.fill("#name-input", name)
    page.click("#name-form button[type=submit]")
    expect(page.locator("#lobby")).to_be_visible()
    page.click("#new-game")
    page.click("#new-game-form button[type=submit]")  # random word, default 5-letter
    expect(page.locator("#wordle-game")).to_be_visible()


def test_normal_guess_path_is_fast_and_unaffected(page: Page, server_url: str):
    sockets = []
    page.on("websocket", lambda ws: sockets.append(ws))

    _join_and_start_game(page, server_url, "ANA")

    start = time.monotonic()
    for ch in "crane":
        page.locator("body").press(ch)
        page.wait_for_timeout(20)
    page.locator("body").press("Enter")

    # Must resolve well under the 5s ack timeout.
    _wait_for_guess_to_land(page, timeout=2000)
    elapsed = time.monotonic() - start
    print(f"[normal path] guess resolved in {elapsed:.2f}s")
    assert elapsed < 2.0, "normal guess path should resolve almost immediately, not stall"
    assert _rows(page) == 1
    # No forced retry should have happened -> exactly one websocket connection opened.
    print(f"[normal path] websocket connections opened: {len(sockets)}")
    assert len(sockets) == 1


def test_force_retry_directly_reopens_socket(page: Page, server_url: str):
    """Fallback / direct verification: call window.Net.forceRetry and confirm it closes the old
    socket and opens a brand new one (proving the close+clear-handlers+reopen mechanics work),
    independent of any network simulation flakiness."""
    sockets = []
    page.on("websocket", lambda ws: sockets.append(ws))

    _join_and_start_game(page, server_url, "BOB")
    page.wait_for_timeout(300)

    # Net is a top-level `const` (IIFE result), so it lives in script scope, not as a `window`
    # property — reference it directly rather than via `window.Net`.
    has_force_retry = page.evaluate(
        "typeof Net !== 'undefined' && typeof Net.forceRetry === 'function'"
    )
    print(f"[direct] Net.forceRetry is a function: {has_force_retry}")
    assert has_force_retry

    before = len(sockets)
    # Use a harmless type; the server will likely ignore/no-op an unknown action but that's fine —
    # we only care that forceRetry closes the live socket and opens a fresh one.
    page.evaluate("Net.forceRetry('ping', {})")
    page.wait_for_timeout(1000)
    after = len(sockets)
    print(f"[direct] websocket connections before={before} after={after}")
    assert after > before, "forceRetry should open a new websocket connection"

    # The game should still be fully usable afterwards (welcome -> flushPending -> normal play).
    expect(page.locator("#wordle-game")).to_be_visible()
    for ch in "crane":
        page.locator("body").press(ch)
        page.wait_for_timeout(20)
    page.locator("body").press("Enter")
    _wait_for_guess_to_land(page, timeout=3000)
    assert _rows(page) == 1


@pytest.mark.parametrize("run", range(8))
def test_simulated_zombie_socket_guess_eventually_lands(
    page: Page, server_url: str, context, run: int
):
    """Best-effort full simulation: go offline at the WS transport level right as a guess is sent,
    stay offline past the 5s ack timeout, then go back online and confirm the guess still lands,
    that a reconnect (new websocket) happened, and — critically — that the guess was recorded
    exactly once (no duplicate row from the original send + the forced retry both reaching the
    server). Repeated several times (parametrized) since the original bug was intermittent,
    depending on whether the "offline" send actually got through despite the simulation."""
    page_errors = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    console_errors = []

    def _on_console(msg):
        if msg.type != "error":
            return
        # Expected noise: while we're simulating offline, the browser itself logs a WS connection
        # failure for any reconnect attempt that happens to occur before we flip back online. That's
        # not an application error — ignore it specifically.
        if "ERR_INTERNET_DISCONNECTED" in msg.text:
            return
        console_errors.append(msg.text)

    page.on("console", _on_console)

    sockets = []
    page.on("websocket", lambda ws: sockets.append(ws))

    _join_and_start_game(page, server_url, f"ZED{run}")
    page.wait_for_timeout(300)
    sockets_before_guess = len(sockets)

    cdp = context.new_cdp_session(page)
    cdp.send("Network.enable")

    for ch in "crane":
        page.locator("body").press(ch)
        page.wait_for_timeout(20)

    # Go offline right before submitting, simulating a zombie connection: ws.readyState still
    # reads OPEN, but no bytes actually get through, and the browser won't fire onclose by itself
    # while "offline" (no TCP-level reset is generated in this simulation).
    cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": True,
            "latency": 0,
            "downloadThroughput": 0,
            "uploadThroughput": 0,
        },
    )
    page.locator("body").press("Enter")
    print("[simulated] went offline, guess submitted, waiting past the 5s ack timeout...")
    page.wait_for_timeout(6500)  # > GUESS_ACK_TIMEOUT_MS (5000ms)

    cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": False,
            "latency": 0,
            "downloadThroughput": -1,
            "uploadThroughput": -1,
        },
    )
    print("[simulated] back online, waiting for guess to land...")

    landed = False
    try:
        _wait_for_guess_to_land(page, timeout=15000)
        landed = True
    except Exception as e:
        print(f"[simulated] guess did not land within timeout: {e}")

    sockets_after = len(sockets)
    print(
        f"[simulated run={run}] websocket connections: "
        f"before_guess={sockets_before_guess} after={sockets_after}"
    )
    print(f"[simulated run={run}] guess landed as a colored row: {landed}")
    if landed:
        print(f"[simulated run={run}] row count: {_rows(page)}")
        feed_html = page.locator("#wordle-feed").inner_html()
        print(f"[simulated run={run}] feed html: {feed_html}")
        board_html = page.locator("#board").inner_html()
        print(f"[simulated run={run}] board html: {board_html[:2000]}")

    assert landed, "guess should eventually land as a colored row after coming back online"
    assert (
        sockets_after > sockets_before_guess
    ), "expected at least one new websocket connection (reconnect) after the simulated drop"

    # The crux of the regression test: exactly one row/guess for "crane" must have been recorded —
    # not two (the original bug: the "offline" send sometimes still reached the server, and the
    # forced retry resent it as if it were a second, distinct guess).
    assert _rows(page) == 1, f"expected exactly 1 row after the single guess, got {_rows(page)}"
    assert _feed_guess_count(page, "crane") == 1, (
        f"expected exactly one 'crane' entry in the feed (no duplicate), "
        f"got {_feed_guess_count(page, 'crane')}"
    )

    assert not page_errors, f"unexpected page errors: {page_errors}"
    assert not console_errors, f"unexpected console errors: {console_errors}"
