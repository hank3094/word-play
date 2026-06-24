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
  //   current    — your own letters, drawn solid on top. May contain spaces (boxes skipped over
  //                via left/right and not yet typed into) -- those render blank, not as letters.
  //   showCursor — whether to show the cursor box (true only when it's your own typing).
  //   cursorPos  — which box (0..wordLength) the cursor sits on.
  //   ghosts     — [{text, color}] from other sharers, overlaid beneath at low opacity.
  function render({
    rows = [],
    current = "",
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
          const ch = current[c];
          if (ch && ch !== " ") {
            // A text node keeps the solid letter on top of any ghost spans.
            tile.appendChild(document.createTextNode(ch));
            tile.classList.add("filled");
          }
          if (showCursor && c === cursorPos) {
            tile.classList.add("cursor");
          }
          if (showCursor && onTileClick) {
            tile.classList.add("clickable");
            tile.addEventListener("click", () => onTileClick(c));
          }
        }
        rowEl.appendChild(tile);
      }
      if (isActive) rowEl.classList.add("active");
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
