"""End-to-end test for cooperative Hangman: two browser contexts against one server.

Covers the realtime path specific to hangman: creating a custom-word game from the generalized
"+ NEW GAME" modal, a shared letter guess updating both players' boards, losing (6 wrong guesses)
without the game ending, and winning anyway afterward.
"""

from playwright.sync_api import Browser, Page, expect


def _enter_lobby(page: Page, server_url: str, name: str) -> None:
    page.goto(server_url)
    expect(page.locator("#name-entry")).to_be_visible()
    page.fill("#name-input", name)
    page.click("#name-form button[type=submit]")
    expect(page.locator("#lobby")).to_be_visible()


def test_cooperative_hangman_lose_then_win(browser: Browser, server_url: str):
    ctx_a = browser.new_context()
    ctx_b = browser.new_context()
    a = ctx_a.new_page()
    b = ctx_b.new_page()
    try:
        # Names distinct from other e2e test files' (ANA/BOB/BEA/ZED...) — this server/session is
        # shared across the whole suite, so the lobby's games list can accumulate other tests'
        # leftover games, and a name substring match must not collide with theirs.
        _enter_lobby(a, server_url, "WREN")
        _enter_lobby(b, server_url, "FOXY")

        # WREN creates a custom-word Hangman game via the generalized "+ NEW GAME" modal.
        a.click("#new-game")
        a.click('#game-type-options input[name="game-type"][value="hangman"]')
        a.click('#hangman-options input[name="hangman-word-mode"][value="custom"]')
        a.fill("#hangman-custom-word", "kiwi")
        a.click("#new-game-form button[type=submit]")
        expect(a.locator("#hangman-game")).to_be_visible()
        expect(a.locator("#hangman-word")).to_have_text("_ _ _ _")

        # FOXY sees it in the lobby (no bogus word-length suffix) and opens it. Scope to the row
        # naming WREN specifically, since other leftover games may also be in the list.
        row = b.locator('#games-list .game-row:has-text("WREN")')
        expect(row).to_contain_text("HANGMAN")
        row.locator("button").first.click()
        expect(b.locator("#hangman-game")).to_be_visible()
        expect(a.locator("#hangman-players")).to_contain_text("FOXY")

        # WREN guesses a correct letter; FOXY's masked word updates too.
        a.click('#hangman-keyboard .kb-key[data-key="k"]')
        expect(b.locator("#hangman-word")).to_have_text("K _ _ _")

        # FOXY guesses 6 wrong letters (none are in "kiwi") — the game becomes "lost" but not
        # finished: both players still see a usable keyboard and a "reveal" option.
        for letter in "qxzyvj":
            b.click(f'#hangman-keyboard .kb-key[data-key="{letter}"]')
        expect(a.locator("#hangman-reveal-row")).to_be_visible()
        expect(b.locator("#hangman-reveal-row")).to_be_visible()
        expect(a.locator(".hm-head")).to_have_class("hm-part hm-head is-drawn")

        # Despite having "lost", WREN can keep guessing and still win.
        a.click('#hangman-keyboard .kb-key[data-key="i"]')
        a.click('#hangman-keyboard .kb-key[data-key="w"]')
        expect(a.locator("#hangman-status")).to_have_text("🎉 SOLVED!")
        expect(b.locator("#hangman-status")).to_have_text("🎉 SOLVED!")
        expect(b.locator("#hangman-word")).to_have_text("K I W I")
    finally:
        ctx_a.close()
        ctx_b.close()


def test_hangman_reveal_after_loss(browser: Browser, server_url: str):
    ctx = browser.new_context()
    page = ctx.new_page()
    try:
        _enter_lobby(page, server_url, "ZED")

        page.click("#new-game")
        page.click('#game-type-options input[name="game-type"][value="hangman"]')
        page.click('#hangman-options input[name="hangman-word-mode"][value="custom"]')
        page.fill("#hangman-custom-word", "dog")
        page.click("#new-game-form button[type=submit]")
        expect(page.locator("#hangman-game")).to_be_visible()

        for letter in "qxzvjk":  # none are in "dog"
            page.click(f'#hangman-keyboard .kb-key[data-key="{letter}"]')
        expect(page.locator("#hangman-reveal-row")).to_be_visible()

        page.click("#hangman-reveal-btn")
        expect(page.locator("#hangman-word")).to_have_text("D O G")
        expect(page.locator("#hangman-status")).to_have_text("word revealed")

        # Leaving and checking history confirms the game was actually finished/recorded.
        page.click('#hangman-game [data-nav="leave"]')
        expect(page.locator("#lobby")).to_be_visible()
        expect(page.locator("#history-list")).to_contain_text("DOG")
    finally:
        ctx.close()
