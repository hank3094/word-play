"""Regression test: a rejected (non-dictionary) guess must not jam input.

Before the fix, the typed word stayed in the buffer after a rejection, so every later valid guess
was silently ignored (the stale invalid word kept being resubmitted).
"""

from playwright.sync_api import Page, expect


def _rows(page: Page) -> int:
    return page.locator("#board .tile.hit, #board .tile.present, #board .tile.miss").count() // 5


def _guess(page: Page, word: str) -> None:
    for ch in word:
        page.locator("body").press(ch)
        page.wait_for_timeout(30)
    page.locator("body").press("Enter")
    page.wait_for_timeout(300)


def test_valid_guess_works_after_a_rejected_one(page: Page, server_url: str):
    page.goto(server_url)
    expect(page.locator("#name-entry")).to_be_visible()
    page.fill("#name-input", "ANA")
    page.click("#name-form button[type=submit]")
    expect(page.locator("#lobby")).to_be_visible()

    page.click("#new-game")
    expect(page.locator("#wordle-game")).to_be_visible()

    _guess(page, "qwxzz")  # not a word -> rejected, no row added
    assert _rows(page) == 0
    _guess(page, "crane")  # a real word -> must register
    assert _rows(page) == 1

    # And a second valid guess straight after also lands (buffer wasn't left stuck).
    if "SOLVED" not in page.locator("#wordle-status").inner_text():
        _guess(page, "mound")
        assert _rows(page) == 2
