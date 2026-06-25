// Renders the Word Ladder board: a fixed skeleton of rows — the start word, every intermediate
// line, then the end word — shown in full from the moment the puzzle is created, not
// progressively revealed. The end row shows the target as faint "ghost" text until the player
// actually fills it in. Each row with real content gets a tick/cross showing whether it's a real
// word and a valid edit from the row above; rows with nothing typed yet don't (nothing to judge).
// In "substitute" mode every row always shows the full wordLength boxes (length is fixed, so
// there's nothing to hide); in "insert_delete" mode a row's length isn't fixed, so it shows one
// box per letter actually there, and -- only while the row is completely empty -- a single
// underscore placeholder hinting where to start typing (it disappears the moment any letter is
// typed; from then on the caret itself marks where the next letter would land). Any row, and any
// letter within it, can be clicked/tapped directly — a blinking vertical caret tracks exactly
// where typing lands.
const LadderBoard = (() => {
  let root = null;
  let onCellClick = null;

  function mount(el, onClick) {
    root = el;
    onCellClick = onClick || null; // (rowIndex, cellIndex)
  }

  // entries: [{word, isWord, isValidEdit}], row 0 always valid (the fixed start word).
  // cells/buffer: the active row's live content -- cells (one slot per box) in substitute mode,
  // buffer (a plain string) in insert_delete mode. Only the one matching `editMode` is used.
  // ghostsByRow: {rowIndex: [{text, color}]} -- other sharers' ideas for that row, overlaid
  // beneath whatever's actually there (own letters or the end-word hint), never affecting it.
  function render({
    entries = [],
    status = "playing",
    parSteps = 1,
    endWord = "",
    editMode = "substitute",
    wordLength = 5,
    editingIndex = null,
    cells = [],
    buffer = "",
    cursorPos = 0,
    ghostsByRow = {},
  } = {}) {
    const totalRows =
      status === "playing"
        ? Math.max(parSteps + 1, entries.length)
        : entries.length;
    const scope = root.closest(".view") || root;
    scope.style.setProperty("--rows", totalRows);

    root.innerHTML = "";
    for (let i = 0; i < totalRows; i++) {
      const stored = entries[i];
      const hasContent = !!(stored && stored.word);
      const isActive = i === editingIndex;
      const isGhostRow =
        status === "playing" && i === totalRows - 1 && !hasContent && !isActive;
      // Substitute mode's boxes are fixed-width, so the active row's content is rendered from
      // `cells` padded back out to a wordLength string (spaces mark empty boxes); insert/delete
      // mode just uses `buffer` directly, since it has no fixed width to pad to.
      const text = isActive
        ? editMode === "substitute"
          ? cells.map((c) => c || " ").join("")
          : buffer
        : hasContent
          ? stored.word
          : "";
      const ghostText = isGhostRow ? endWord : "";
      const peerGhosts = ghostsByRow[i] || [];

      const rowEl = document.createElement("div");
      rowEl.className = "ladder-row";
      rowEl.dataset.index = i;
      if (isActive) rowEl.classList.add("active");
      if (isGhostRow) rowEl.classList.add("ghost-row");
      if (hasContent && !stored.isWord) rowEl.classList.add("invalid-word");
      if (hasContent && stored.isWord && !stored.isValidEdit)
        rowEl.classList.add("invalid-edit");

      // Substitute mode: every row is the puzzle's fixed word length, full stop. Insert/delete
      // mode: real content gets one full box each -- a peer's longer/shorter guess for the same
      // row is sized in too, so their idea is still visible over a blank row.
      const longestPeerGhost = peerGhosts.reduce(
        (n, g) => Math.max(n, g.text.length),
        0,
      );
      const shown = text || ghostText;
      const contentLen =
        editMode === "substitute"
          ? wordLength
          : Math.max(shown.length, longestPeerGhost);
      // Only while insert/delete mode's row is completely empty: a single "type here" hint. The
      // moment any letter's typed, this disappears and the caret marks the spot instead.
      const hasUnderscore =
        editMode !== "substitute" &&
        !isGhostRow &&
        i !== 0 &&
        text.length === 0;

      // Row 0 (the fixed start word) and the not-yet-reached end-word ghost row are both given,
      // not the player's to pick directly -- clicking either disabled here; the ghost row stops
      // being one (and so becomes clickable) the moment it's actually reached via normal
      // row-by-row play (Enter/arrow keys advance one row at a time and don't go through this).
      const clickable = i >= 1 && !isGhostRow && onCellClick;
      // The real-content tiles live in their own wrapper, and it's the *only* flex child of
      // rowEl -- so centering is based purely on the word's own tiles. The trailing underscore
      // and the tick/cross mark both ride along after it via absolute positioning instead of
      // sitting in the centered flex flow, so neither adds to the width centering is based on.
      const tilesWrap = document.createElement("div");
      tilesWrap.className = "ladder-row-tiles";

      for (let c = 0; c < contentLen; c++) {
        const tile = document.createElement("div");
        tile.className = "tile";
        for (const g of peerGhosts) {
          const ch = g.text[c];
          if (!ch) continue;
          const span = document.createElement("span");
          span.className = "tile-ghost";
          span.textContent = ch;
          if (g.color) span.style.color = g.color;
          tile.appendChild(span);
        }
        if (c < text.length && text[c] !== " ") {
          tile.appendChild(document.createTextNode(text[c]));
          tile.classList.add("filled");
        } else if (ghostText && c < ghostText.length) {
          tile.appendChild(document.createTextNode(ghostText[c]));
          tile.classList.add("ghost");
        }
        if (clickable) {
          tile.addEventListener("click", (e) => {
            e.stopPropagation();
            // Split the tile down the middle -- the caret lands on whichever side of it the
            // click was closer to, same as clicking text in any normal editor.
            const rect = tile.getBoundingClientRect();
            const before = e.clientX - rect.left < rect.width / 2;
            onCellClick(i, before ? c : c + 1);
          });
        }
        tilesWrap.appendChild(tile);
      }
      if (hasUnderscore) {
        // Purely a "type here" hint -- not clickable/cursor-aware itself; the row-level click
        // fallback below already lands the caret at the right spot for an empty row.
        const underscore = document.createElement("div");
        underscore.className = "tile next-slot";
        tilesWrap.appendChild(underscore);
      }
      if (isActive) {
        const caret = document.createElement("div");
        caret.className = "caret";
        // cursorPos can be contentLen (just past the last box) -- there's no box there to anchor
        // a left edge to, so anchor to the last real box's column instead and flip to its right
        // edge rather than its left.
        const pos = Math.max(0, cursorPos);
        if (contentLen > 0 && pos >= contentLen) {
          caret.style.setProperty("--caret-index", contentLen - 1);
          caret.classList.add("caret-end");
        } else {
          caret.style.setProperty("--caret-index", pos);
        }
        tilesWrap.appendChild(caret);
      }

      // Tick/cross for whether the row's a real word and a valid edit -- absolutely positioned
      // off tilesWrap too (after the underscore's slot, when there is one), so judging the word
      // never shifts where the word itself sits either.
      const mark = document.createElement("span");
      mark.className = "ladder-row-mark";
      mark.classList.add(hasUnderscore ? "after-next-slot" : "after-tiles");
      if (hasContent && i !== 0) {
        const ok = stored.isWord && stored.isValidEdit;
        mark.classList.add(ok ? "ok" : "bad");
        mark.textContent = ok ? "✓" : "✗";
      }
      tilesWrap.appendChild(mark);

      rowEl.appendChild(tilesWrap);
      // Fallback for a tap that lands in the row's padding/gap rather than on a specific tile —
      // tile clicks above stop propagation, so this only fires when none of them did. Infinity
      // lets the controller's own clamp decide what "past the end" means for this row's mode.
      if (clickable) {
        rowEl.addEventListener("click", () => onCellClick(i, Infinity));
      }
      root.appendChild(rowEl);
    }
  }

  function flashInvalid() {
    const active = root.querySelector(".ladder-row.active");
    if (!active) return;
    active.classList.add("invalid");
    setTimeout(() => active.classList.remove("invalid"), 350);
  }

  return { mount, render, flashInvalid };
})();
