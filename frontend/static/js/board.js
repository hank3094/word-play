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
  //   current  — your own (or a single exclusive sharer's) letters, drawn solid on top.
  //   showCursor — whether to show the next-cell cursor (true only when it's your own typing).
  //   tint     — colour for a single exclusive sharer's mirrored letters (pastel tile fill).
  //   ghosts   — [{text, color}] from other simultaneous sharers, overlaid beneath at low opacity.
  function render({
    rows = [],
    current = "",
    showCursor = true,
    wordLength = 5,
    maxGuesses = 6,
    tint = null,
    ghosts = null,
  } = {}) {
    cols = wordLength;
    maxRows = maxGuesses;
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
          if (ch) {
            // A text node keeps the solid letter on top of any ghost spans.
            tile.appendChild(document.createTextNode(ch));
            tile.classList.add("filled");
            if (tint) {
              tile.style.background = `color-mix(in srgb, ${tint} 30%, var(--panel))`;
            }
          } else if (showCursor && c === current.length) {
            tile.classList.add("cursor"); // next cell to fill
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
