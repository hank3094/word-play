// Renders the shared Wordle grid: completed rows with colour marks, an active "cursor" row showing
// whatever is being typed right now, and empty rows for the remaining guesses.
const Board = (() => {
  let root = null;
  let cols = 5;
  let maxRows = 6;

  function mount(el) {
    root = el;
  }

  // rows: [{word, marks}], current: the live text in the next row, length: word length.
  function render({
    rows = [],
    current = "",
    wordLength = 5,
    maxGuesses = 6,
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
          const ch = current[c];
          if (ch) {
            tile.textContent = ch;
            tile.classList.add("filled");
          } else if (c === current.length) {
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
