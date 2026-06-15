"""End-to-end test for cooperative play: two browser contexts against one server.

Covers the whole realtime path — presence, creating/opening a shared game, live typing visible to
the other player, and a shared guess colouring the board for both.
"""

from playwright.sync_api import Browser, Page, expect


def _enter_lobby(page: Page, server_url: str, name: str) -> None:
    page.goto(server_url)
    expect(page.locator("#name-entry")).to_be_visible()
    page.fill("#name-input", name)
    page.click("#name-form button[type=submit]")
    expect(page.locator("#lobby")).to_be_visible()


def test_cooperative_wordle(browser: Browser, server_url: str):
    ctx_a = browser.new_context()
    ctx_b = browser.new_context()
    a = ctx_a.new_page()
    b = ctx_b.new_page()
    try:
        _enter_lobby(a, server_url, "ANA")
        _enter_lobby(b, server_url, "BOB")

        # Presence: each sees the other on the page.
        expect(a.locator("#players-list")).to_contain_text("ANA")
        expect(a.locator("#players-list")).to_contain_text("BOB")
        expect(b.locator("#players-list")).to_contain_text("ANA")

        # ANA creates a Wordle and is dropped into the shared board.
        a.click("#new-game")
        expect(a.locator("#wordle-game")).to_be_visible()
        expect(a.locator("#board .board-row")).to_have_count(6)

        # BOB sees the new game in the lobby and opens it.
        expect(b.locator("#games-list")).to_contain_text("WORDLE")
        b.click("#games-list .game-row button")
        expect(b.locator("#wordle-game")).to_be_visible()
        # ANA now sees BOB has joined.
        expect(a.locator("#wordle-players")).to_contain_text("BOB")

        # ANA types — BOB sees the live "is typing…" indicator.
        for ch in ["c", "r", "a"]:
            a.locator("body").press(ch)
        b.wait_for_function(
            "document.querySelector('#wordle-feed').textContent.toLowerCase().includes('typing')",
            timeout=5000,
        )

        # ANA completes and submits a valid guess; BOB's shared board fills with coloured tiles.
        for ch in ["n", "e", "Enter"]:
            a.locator("body").press(ch)
        b.wait_for_function(
            "document.querySelectorAll("
            "'#board .tile.hit, #board .tile.present, #board .tile.miss').length >= 5",
            timeout=5000,
        )
        # The guess is attributed to ANA in BOB's feed.
        expect(b.locator("#wordle-feed")).to_contain_text("ANA")
    finally:
        ctx_a.close()
        ctx_b.close()
