// Client controller for Word Ladder. Unlike Wordle/Hangman's single shared board, each player
// races on their own independent board (see games/gametypes/wordladder.py's module docstring) --
// "cooperation" here is limited to optionally sharing your screen, exactly like Wordle's
// share-toggle, except sharing shows a peer's row contents (typed-or-committed, no distinction)
// as ghost overlays rather than just live keystrokes. The moment anyone wins, their board freezes
// as the one everyone sees from then on. Nothing the server stores is secret or rejected outright
// — any row can be edited, and an invalid word just sits there flagged (see ladderboard.js's
// invalid-word/invalid-edit classes), so there's no guess-ack watchdog or pending/rejected dance
// to manage here. Fully re-rendered from each snapshot.
const WordLadder = (() => {
  let els = {};
  let myId = null;
  let gid = null;
  let snap = null;
  let editingIndex = null; // which row (1..maxEditableIndex()) the local buffer is editing
  let buffer = "";
  let cursorPos = 0; // caret position within buffer (0..buffer.length)
  let selectionReady = false; // whether the default top-row selection has been applied yet
  let typingPeers = {}; // pid -> {name, text, index, color}: other sharers' live typing
  let lastTypingSent = 0;
  let pendingWords = {}; // rowIndex -> word just submitted, shown until the snapshot confirms it
  // (otherwise the row briefly re-renders its old stored word from the stale snapshot still in
  // flight before the server's reply lands -- see switchRow/focusRow leaving a just-edited row).

  function init(refs) {
    els = refs;
    LadderBoard.mount(els.board, (rowIndex, cellIndex) =>
      selectCell(rowIndex, cellIndex),
    );
    if (els.shareToggleBtn) {
      els.shareToggleBtn.addEventListener("click", () => {
        Net.send(iAmSharing() ? "share_stop" : "share_start", { gameId: gid });
      });
    }
    if (els.solutionBtn) {
      els.solutionBtn.addEventListener("click", () => {
        Net.send("game_action", {
          gameId: gid,
          action: "reveal_solution",
          data: {},
        });
      });
    }
  }

  function setMyId(id) {
    myId = id;
  }

  function open(gameId) {
    gid = gameId;
    editingIndex = null;
    buffer = "";
    cursorPos = 0;
    selectionReady = false;
    typingPeers = {};
    pendingWords = {};
  }

  function reset() {
    gid = null;
    snap = null;
    editingIndex = null;
    buffer = "";
    cursorPos = 0;
    selectionReady = false;
    typingPeers = {};
    pendingWords = {};
  }

  function board() {
    return snap ? snap.board : null;
  }
  function isPlaying() {
    return board() && board().status === "playing";
  }
  // Each player's own rows, defaulting to just the (fixed, always-valid) start word until they've
  // made their first move. Once finished, everyone sees the winner's frozen rows instead. Rows
  // with a pending (just-submitted, not yet server-confirmed) word show that word instead of
  // whatever's still in this stale-by-definition snapshot.
  function myRows() {
    const b = board();
    if (!b) return [];
    const rows =
      b.status === "won"
        ? b.boards[b.winnerPid] || []
        : b.boards[myId] || [
            { word: b.startWord, isWord: true, isValidEdit: true },
          ];
    if (!Object.keys(pendingWords).length) return rows;
    return rows.map((row, i) =>
      i in pendingWords ? { ...row, word: pendingWords[i] } : row,
    );
  }
  // The puzzle's full skeleton is always shown (start + every intermediate + end); this is the
  // last row index a player can navigate/type into. Row 0 (the start word) never is, and neither
  // is the topmost slot while it's still empty -- that's the end word's spot, fixed like row 0
  // until there's real content sitting in it (which, given this, there never will be via the UI;
  // the check is kept anyway in case a row gets content some other way, e.g. a stale board).
  function maxEditableIndex() {
    const b = board();
    const rows = myRows();
    const topIndex = Math.max(b.parSteps, rows.length - 1);
    if (topIndex > 0 && !(rows[topIndex] || {}).word) return topIndex - 1;
    return topIndex;
  }

  function applySnapshot(s) {
    if (s.id !== gid) return;
    snap = s;
    const b = board();
    // pendingWords only means anything while I'm actively playing my own board -- once play ends
    // (anyone wins), there's nothing left to reconcile: I can't submit further actions, and once
    // won the server only reports the *winner's* board, so a non-winner's pendingWords could
    // never be confirmed against it and would otherwise leak, stale, into the rendering of the
    // winner's frozen board (myRows() overlays pendingWords by row index regardless of whose
    // board is showing).
    if (!isPlaying()) {
      pendingWords = {};
      editingIndex = null;
      buffer = "";
    } else {
      const confirmedRows = b.boards[myId] || [];
      for (const i of Object.keys(pendingWords)) {
        if ((confirmedRows[i] || {}).word === pendingWords[i]) {
          delete pendingWords[i];
        }
      }
      if (!selectionReady) {
        // Default: start at the top row, seeded with whatever's already there (e.g. rejoining a
        // game in progress).
        selectionReady = true;
        const row = myRows()[1];
        editingIndex = 1;
        buffer = row ? row.word : "";
        cursorPos = buffer.length;
      } else if (editingIndex > maxEditableIndex()) {
        editingIndex = maxEditableIndex();
      }
    }
    render();
  }

  function onFeed(ev) {
    if (ev.kind === "typing") {
      typingPeers[ev.pid] = {
        name: ev.name,
        text: ev.text || "",
        index: ev.index,
      };
      renderBoard();
      renderFeed();
    }
  }

  // Substitute mode's boxes are fixed at wordLength regardless of how much has actually been
  // typed, so the cursor can sit anywhere in that range; insert/delete mode has no fixed length,
  // so the cursor can't go past whatever's actually there.
  function maxCursor() {
    const b = board();
    return b.editMode === "substitute" ? b.wordLength : buffer.length;
  }

  function submitCurrentRow() {
    pendingWords[editingIndex] = buffer;
    Net.send("game_action", {
      gameId: gid,
      action: "set_word",
      // Sent exactly as typed, gaps (placeholder spaces) included -- the server treats a word with
      // any gap, left/internal/right, as not a real word rather than silently closing it up.
      data: { index: editingIndex, word: buffer },
    });
  }

  // Changes which row the buffer points at, re-seeding it from that row's stored content. Doesn't
  // submit anything itself -- callers decide whether the row being left needs committing first.
  function switchRow(index, desiredCursor) {
    if (!isPlaying() || index < 1 || index > maxEditableIndex()) return;
    if (index !== editingIndex) {
      const row = myRows()[index];
      buffer = row ? row.word : "";
    }
    editingIndex = index;
    cursorPos = Math.max(0, Math.min(desiredCursor, maxCursor()));
    renderBoard();
    sendTyping();
  }

  // Arrow-key and click/tap navigation: commit whatever's typed in the row being left (so it's
  // never silently lost by moving away without pressing Enter), then switch. Skipped if nothing
  // actually changed, so just passing through a row doesn't post a no-op edit.
  function focusRow(index, desiredCursor) {
    if (index !== editingIndex && editingIndex !== null) {
      const storedWord = (myRows()[editingIndex] || {}).word || "";
      if (buffer !== storedWord) submitCurrentRow();
    }
    switchRow(index, desiredCursor);
  }

  function selectCell(rowIndex, cellIndex) {
    focusRow(rowIndex, cellIndex);
  }

  function input(key) {
    if (!isPlaying() || editingIndex === null) return;

    if (key === "enter") {
      submitCurrentRow();
      // Substitute mode's boxes are fixed, so the next row starts fresh at position 0; insert/
      // delete mode has no fixed length, so picking up after whatever's already there (the end of
      // its buffer) makes more sense.
      const landAt = board().editMode === "substitute" ? 0 : Infinity;
      switchRow(Math.min(editingIndex + 1, maxEditableIndex()), landAt);
      return;
    }
    if (key === "up") {
      focusRow(editingIndex - 1, cursorPos);
      return;
    }
    if (key === "down") {
      focusRow(editingIndex + 1, cursorPos);
      return;
    }
    if (key === "left") {
      cursorPos = Math.max(0, cursorPos - 1);
      renderBoard();
      return;
    }
    if (key === "right") {
      if (board().editMode === "insert_delete" && cursorPos === buffer.length) {
        // Past the last real character: stepping right grows the word by one empty placeholder
        // box rather than just moving a caret that has nowhere further to go.
        if (buffer.length < 24) {
          buffer += " ";
          cursorPos += 1;
          renderBoard();
          sendTyping();
        }
        return;
      }
      cursorPos = Math.min(maxCursor(), cursorPos + 1);
      renderBoard();
      return;
    }
    const b = board();
    if (key === "back") {
      if (b.editMode === "substitute") {
        // Overwrite-in-place, not a shift: clearing a box leaves the others where they are. Pad
        // with spaces first since the cursor may sit past the end of what's actually been typed
        // (substitute mode lets you click ahead to any of the fixed boxes).
        const padded = buffer.padEnd(b.wordLength, " ");
        // Clears whichever box the cursor is over -- the one under it if it's sitting on a real
        // tile, otherwise (past the last box) the last real one -- then steps back, same as a
        // normal backspace, so repeated presses walk back through the word clearing as they go.
        const target = Math.min(cursorPos, b.wordLength - 1);
        buffer = (
          padded.slice(0, target) +
          " " +
          padded.slice(target + 1)
        ).replace(/ +$/, "");
        cursorPos = Math.max(0, cursorPos - 1);
      } else {
        if (buffer.length === 0) return;
        // Deletes whichever slot the cursor is over -- the one under it if it's sitting on a real
        // tile (letter or placeholder box), otherwise (past the last character, on the trailing
        // underscore) the last real one -- then steps back, same as a normal backspace.
        const target = Math.min(cursorPos, buffer.length - 1);
        buffer = buffer.slice(0, target) + buffer.slice(target + 1);
        cursorPos = Math.max(0, cursorPos - 1);
      }
    } else if (/^[a-z]$/.test(key)) {
      if (b.editMode === "substitute") {
        // Every row is exactly wordLength boxes -- typing overwrites whichever box the cursor
        // sits on (there's nowhere for an inserted extra letter to go), capped at that length.
        // Padded the same way as backspace, for the same reason (cursor may be past buffer.length).
        if (cursorPos >= b.wordLength) return;
        const padded = buffer.padEnd(b.wordLength, " ");
        buffer = (
          padded.slice(0, cursorPos) +
          key +
          padded.slice(cursorPos + 1)
        ).replace(/ +$/, "");
        cursorPos += 1;
      } else if (buffer[cursorPos] === " ") {
        // Sitting in an empty placeholder box (created by stepping right past the end) -- fill it
        // in place rather than inserting another letter and leaving the placeholder behind.
        buffer = buffer.slice(0, cursorPos) + key + buffer.slice(cursorPos + 1);
        cursorPos += 1;
      } else if (buffer.length < 24) {
        buffer = buffer.slice(0, cursorPos) + key + buffer.slice(cursorPos);
        cursorPos += 1;
      } else {
        return;
      }
    } else if (key === "space") {
      // No on-screen arrow keys on mobile, so stepping right past the end to grow a placeholder
      // (see the "right" handler above) isn't reachable there -- this is the only way to insert
      // an empty box without an external keyboard, so it always inserts, anywhere in the word.
      if (b.editMode !== "insert_delete" || buffer.length >= 24) return;
      buffer = buffer.slice(0, cursorPos) + " " + buffer.slice(cursorPos);
      cursorPos += 1;
    } else {
      return;
    }
    renderBoard();
    sendTyping();
  }

  function onRejected() {
    // Word ladder only rejects structural issues (bad index, already finished) — none of which
    // the UI itself can trigger in normal use. Flash and bail defensively.
    pendingWords = {};
    LadderBoard.flashInvalid();
    renderBoard();
  }

  // --- sharing helpers (mirrors wordle.js) ---
  function iAmSharing() {
    return !!snap && (snap.sharers || []).includes(myId);
  }
  function colorOf(pid) {
    const p = snap && snap.players.find((x) => x.id === pid);
    return p && safeColor(p.color) ? p.color : "";
  }

  function sendTyping() {
    if (!iAmSharing()) return; // only broadcast keystrokes while sharing
    const now = performance.now();
    if (now - lastTypingSent >= 90) {
      lastTypingSent = now;
      Net.send("game_action", {
        gameId: gid,
        action: "typing",
        data: { text: buffer, index: editingIndex },
      });
    }
  }

  // Other sharers' content per row -- their live typing where they're currently editing, else
  // whatever they've actually committed there. Either way it's just a visual idea, never touches
  // my own board.
  function ghostsByRow() {
    if (!isPlaying() || !iAmSharing()) return {};
    const b = board();
    const byRow = {};
    for (const pid of snap.sharers || []) {
      if (pid === myId) continue;
      const peerColor = colorOf(pid);
      const peerRows = b.boards[pid] || [];
      const typing = typingPeers[pid];
      const rows = new Set(peerRows.map((_row, i) => i));
      if (typing) rows.add(typing.index);
      for (const i of rows) {
        const text =
          typing && typing.index === i
            ? typing.text
            : (peerRows[i] || {}).word || "";
        if (!text) continue;
        (byRow[i] = byRow[i] || []).push({ text, color: peerColor });
      }
    }
    return byRow;
  }

  // --- rendering ---
  function renderInfo() {
    const b = board();
    const usedSteps = myRows().length - 1;
    els.info.innerHTML =
      `<b>${b.startWord.toUpperCase()}</b> → <b>${b.endWord.toUpperCase()}</b>` +
      ` · step ${usedSteps} of ${b.parSteps}` +
      ` · ${b.difficulty}` +
      (b.editMode === "insert_delete" ? " · insert/delete allowed" : "");
    // The on-screen SPACE key only makes sense where word length isn't fixed -- substitute mode
    // has no use for it (and no physical-keyboard equivalent for it either, since input() ignores
    // it there too).
    if (els.keyboard)
      els.keyboard.setSpaceVisible(b.editMode === "insert_delete");
  }

  function renderBoard() {
    const b = board();
    if (!b) return;
    LadderBoard.render({
      entries: myRows(),
      status: b.status,
      parSteps: b.parSteps,
      endWord: b.endWord,
      editMode: b.editMode,
      wordLength: b.wordLength,
      editingIndex,
      current: buffer,
      cursorPos,
      ghostsByRow: ghostsByRow(),
    });
  }

  function renderPlayers() {
    if (!snap.players.length) {
      els.players.innerHTML = "";
      return;
    }
    const sharers = snap.sharers || [];
    els.players.innerHTML = snap.players
      .map((p) => {
        const style = safeColor(p.color) ? ` style="color:${p.color}"` : "";
        const sharing = sharers.includes(p.id);
        const badge = ` <span class="share-badge${
          sharing ? " is-on" : ""
        }" title="${escapeHtml(p.name)} is ${
          sharing ? "sharing" : "not sharing"
        }">📡</span>`;
        return `<span class="dot"${style}>●</span>${escapeHtml(
          p.name,
        )}${badge}`;
      })
      .join(" ");
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : str;
    return d.innerHTML;
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c || "") ? c : "";
  }

  function renderStatus() {
    const b = board();
    els.status.textContent = b.status === "won" ? "🎉 SOLVED!" : "in progress";
  }

  function fmtFeed(ev) {
    if (ev.kind === "win")
      return `🎉 ${ev.name} solved it — ${ev.word.toUpperCase()}`;
    if (ev.kind === "ladder_step")
      return `${ev.name}: ${ev.word.toUpperCase()} (row ${
        (ev.index || 0) + 1
      })`;
    return "";
  }

  function renderFeed() {
    const durable = snap.feed.filter((e) => e.kind !== "typing");
    const last = durable[durable.length - 1];
    els.feed.innerHTML = last ? `<div>${fmtFeed(last)}</div>` : "";
  }

  function renderSolution() {
    const b = board();
    if (els.solutionBtn) els.solutionBtn.hidden = !b || !!b.solution;
    if (!els.solutionRow) return;
    if (b && b.solution) {
      els.solutionRow.textContent = b.solution
        .map((w) => w.toUpperCase())
        .join(" → ");
      els.solutionRow.hidden = false;
    } else {
      els.solutionRow.hidden = true;
    }
  }

  function renderShareControls() {
    if (!els.shareToggleBtn) return;
    const playing = isPlaying();
    const allow = !!snap.allowSharing;
    const mine = iAmSharing();
    els.shareToggleBtn.hidden = !playing || !allow;
    els.shareToggleBtn.textContent = mine ? "📡 SHARING ON" : "📡 SHARING OFF";
    els.shareToggleBtn.setAttribute("aria-pressed", String(mine));
    els.shareToggleBtn.classList.toggle("is-on", mine);
  }

  function render() {
    renderInfo();
    renderBoard();
    renderPlayers();
    renderStatus();
    renderFeed();
    renderShareControls();
    renderSolution();
    if (els.delete) els.delete.hidden = !(snap.owner && snap.owner === myId);
  }

  return {
    init,
    setMyId,
    open,
    reset,
    applySnapshot,
    onFeed,
    input,
    onRejected,
    currentGame: () => gid,
  };
})();
