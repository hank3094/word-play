// Renders the Word Ladder board: a fixed skeleton of rows — the start word, every intermediate
// line, then the end word — shown in full from the moment the puzzle is created, not
// progressively revealed. The end row shows the target as faint "ghost" text until the player
// actually fills it in. Each row with real content gets a tick/cross showing whether it's a real
// word and a valid edit from the row above; rows with nothing typed yet don't (nothing to judge).
// In "substitute" mode every row always shows the full wordLength boxes (length is fixed, so
// there's nothing to hide); in "insert_delete" mode a row's length isn't fixed, so it shows one
// full box per letter/inserted-blank actually there, then a trailing underscore marking the next
// position typing would land on -- that underscore is just where-to-type, not real content, so it
// never counts as part of the word. Any row, and any letter within it, can be clicked/tapped
// directly — the green-outlined "cursor" box tracks exactly where typing lands.
const LadderBoard = (() => {
  let root = null;
  let onCellClick = null;

  function mount(el, onClick) {
    root = el;
    onCellClick = onClick || null; // (rowIndex, cellIndex)
  }

  // entries: [{word, isWord, isValidEdit}], row 0 always valid (the fixed start word).
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
    current = "",
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
      const text = isActive ? current : hasContent ? stored.word : "";
      const ghostText = isGhostRow ? endWord : "";
      // Don't clamp to text.length here -- in substitute mode the caret can sit in any of the
      // fixed boxes past whatever's actually been typed (clamping it hid the highlight whenever
      // arrow keys moved past the last typed letter).
      const cursor = isActive ? Math.max(0, cursorPos) : -1;
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
      // mode: real content (letters, or blanks the player explicitly inserted) gets one full box
      // each -- a peer's longer/shorter guess for the same row is sized in too, so their idea is
      // still visible over a blank row -- plus one extra trailing underscore slot beyond that,
      // for the next position typing would land on.
      const longestPeerGhost = peerGhosts.reduce(
        (n, g) => Math.max(n, g.text.length),
        0,
      );
      const shown = text || ghostText;
      const contentLen =
        editMode === "substitute"
          ? wordLength
          : Math.max(shown.length, longestPeerGhost);
      const hasUnderscore = editMode !== "substitute" && !isGhostRow && i !== 0;

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
        if (isActive && c === cursor) tile.classList.add("cursor");
        if (clickable) {
          tile.addEventListener("click", (e) => {
            e.stopPropagation();
            onCellClick(i, c);
          });
        }
        tilesWrap.appendChild(tile);
      }
      if (hasUnderscore) {
        const underscore = document.createElement("div");
        underscore.className = "tile next-slot";
        if (isActive && cursor === contentLen)
          underscore.classList.add("cursor");
        if (clickable) {
          underscore.addEventListener("click", (e) => {
            e.stopPropagation();
            onCellClick(i, contentLen);
          });
        }
        tilesWrap.appendChild(underscore);
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
      // tile clicks above stop propagation, so this only fires when none of them did.
      if (clickable) {
        rowEl.addEventListener("click", () => onCellClick(i, contentLen));
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
