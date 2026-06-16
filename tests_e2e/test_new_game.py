"""End-to-end test for the new-game modal: random vs. a custom (masked) word."""

from playwright.sync_api import Page, expect


def _lobby(page: Page, server_url: str, name: str = "ANA") -> None:
    page.goto(server_url)
    expect(page.locator("#name-entry")).to_be_visible()
    page.fill("#name-input", name)
    page.click("#name-form button[type=submit]")
    expect(page.locator("#lobby")).to_be_visible()


def test_custom_word_flow(page: Page, server_url: str):
    _lobby(page, server_url)

    page.click("#new-game")
    expect(page.locator("#new-game-modal")).to_be_visible()
    # Custom-word row is hidden until "Choose the word" is picked.
    expect(page.locator("#custom-word-row")).to_be_hidden()
    page.check('input[name="word-mode"][value="custom"]')
    expect(page.locator("#custom-word-row")).to_be_visible()

    # The word input is masked by default; the reveal toggle un-masks it.
    assert page.locator("#custom-word").get_attribute("type") == "password"
    page.click("#toggle-word")
    assert page.locator("#custom-word").get_attribute("type") == "text"

    # A word that isn't in the list is rejected by the server (no game created).
    page.fill("#custom-word", "zzzzz")
    page.click("#new-game-form button[type=submit]")
    expect(page.locator("#new-game-error")).to_be_visible()
    expect(page.locator("#wordle-game")).to_be_hidden()

    # A valid word creates a game where that word is the answer — guessing it wins.
    page.fill("#custom-word", "crane")
    page.click("#new-game-form button[type=submit]")
    expect(page.locator("#wordle-game")).to_be_visible()
    expect(page.locator("#new-game-modal")).to_be_hidden()

    for ch in "crane":
        page.locator("body").press(ch)
        page.wait_for_timeout(20)
    page.locator("body").press("Enter")
    expect(page.locator("#wordle-status")).to_contain_text("SOLVED")


def test_cancel_closes_modal_without_creating(page: Page, server_url: str):
    _lobby(page, server_url, "BEA")
    page.click("#new-game")
    expect(page.locator("#new-game-modal")).to_be_visible()
    page.click('[data-modal="cancel"]')
    expect(page.locator("#new-game-modal")).to_be_hidden()
    expect(page.locator("#lobby")).to_be_visible()
