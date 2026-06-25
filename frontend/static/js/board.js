// Renders the shared Wordle grid: completed rows with colour marks, an active "cursor" row showing
// whatever is being typed right now, and empty rows for the remaining guesses.
const Board = (() => {
  let root = null;
  let cols = 5;
  let maxRows = 6;

  function mount(el) {
    root = el;
  }

  // rows: [{word, marks}]. The active row shows the live letters:
  //   cells      — your own letters, one slot per box ("" or a letter), drawn solid on top.
  //   showCursor — whether to show the caret (true only when it's your own typing).
  //   cursorPos  — which box (0..wordLength-1) the caret sits on.
  //   ghosts     — [{text, color}] from other sharers, overlaid beneath at low opacity.
  function render({
    rows = [],
    cells = [],
    showCursor = true,
    cursorPos = 0,
    wordLength = 5,
    maxGuesses = 6,
    ghosts = null,
    onTileClick = null,
  } = {}) {
    cols = wordLength;
    maxRows = maxGuesses;
    // Set on the view, not just the board, so sibling UI (keyboard, feed) can also
    // scale down for word lengths with more guess rows (e.g. 7 letters -> 8 rows).
    const scope = root.closest(".view") || root;
    scope.style.setProperty("--cols", wordLength);
    scope.style.setProperty("--rows", maxGuesses);
    root.innerHTML = "";
    const activeIndex = rows.length;
    for (let r = 0; r < maxRows; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "board-row";
      rowEl.dataset.row = r;
      const filled = rows[r];
      const isActive = r === activeIndex;
      for (let c = 0; c < cols; c++) {
        const tile = document.createElement("div");
        tile.className = "tile";
        // Explicit, not auto-placed -- the active row's caret is also explicitly placed and may
        // share a column with the last tile; auto-placement would otherwise treat that column as
        // "taken" by the caret and bump this tile onto a new row instead of overlapping it.
        tile.style.gridRow = "1";
        tile.style.gridColumn = c + 1;
        if (filled) {
          tile.textContent = filled.word[c] || "";
          tile.classList.add(filled.marks[c]); // hit | present | miss
        } else if (isActive) {
          // Other sharers' letters first, stacked beneath, each in their own colour.
          if (ghosts) {
            for (const g of ghosts) {
              const ch = (g.text || "")[c];
              if (!ch) continue;
              const span = document.createElement("span");
              span.className = "tile-ghost";
              span.textContent = ch;
              if (g.color) span.style.color = g.color;
              tile.appendChild(span);
            }
          }
          const ch = cells[c];
          if (ch) {
            // A text node keeps the solid letter on top of any ghost spans.
            tile.appendChild(document.createTextNode(ch));
            tile.classList.add("filled");
          }
          if (showCursor && onTileClick) {
            tile.classList.add("clickable");
            tile.addEventListener("click", (e) => {
              // Split the tile down the middle -- the caret lands on whichever side of it the
              // click was closer to, same as clicking text in any normal editor.
              const rect = tile.getBoundingClientRect();
              const before = e.clientX - rect.left < rect.width / 2;
              onTileClick(before ? c : c + 1);
            });
          }
        }
        rowEl.appendChild(tile);
      }
      if (isActive) {
        rowEl.classList.add("active");
        if (showCursor) {
          // Placed as a real grid item in the cursor's column, not absolutely positioned --
          // the row's own grid tracks already handle alignment/gaps correctly.
          const caret = document.createElement("div");
          caret.className = "caret";
          // Both axes explicit -- the column's already occupied by that box's tile, and grid
          // auto-placement would otherwise push an item with only a column set onto a new row.
          caret.style.gridRow = "1";
          // cursorPos can be `len` (past the last box, e.g. right after typing/clicking the last
          // letter) -- there's no column there, so anchor to the last box's column instead and
          // flip to its right edge rather than its left.
          if (cursorPos >= cols) {
            caret.style.gridColumn = cols;
            caret.classList.add("caret-end");
          } else {
            caret.style.gridColumn = cursorPos + 1;
          }
          rowEl.appendChild(caret);
        }
      }
      root.appendChild(rowEl);
    }
  }

  function flashInvalid() {
    const active = root.querySelector(".board-row.active");
    if (!active) return;
    active.classList.add("invalid");
    setTimeout(() => active.classList.remove("invalid"), 350);
  }

  return { mount, render, flashInvalid };
})();
