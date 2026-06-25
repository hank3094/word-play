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
  let editingIndex = null; // which row (1..maxEditableIndex()) is being edited
  // Substitute mode (fixed wordLength per row) uses `cells`: one slot per box, "" or a letter,
  // typed into by overwriting whichever box the cursor's on. Insert/delete mode (no fixed
  // length) uses `buffer`: a plain string with a real text caret that inserts/deletes-and-shifts.
  // Only one is ever "live" -- which one depends on board().editMode, which is fixed per game.
  let cells = [];
  let buffer = "";
  // cursorPos means a box index (0..wordLength-1) in substitute mode, or a caret gap
  // (0..buffer.length) in insert/delete mode.
  let cursorPos = 0;
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
    cells = [];
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
    cells = [];
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
      cells = [];
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
        seedRow(row ? row.word : "");
        // Substitute mode's boxes are an overwrite grid -- start at the first one. Insert/delete
        // mode has a real end-of-text to land at.
        cursorPos = b.editMode === "substitute" ? 0 : buffer.length;
      } else if (editingIndex > maxEditableIndex()) {
        editingIndex = maxEditableIndex();
      }
    }
    render();
  }

  // Loads a stored row's word into whichever representation the board's editMode actually uses.
  function seedRow(word) {
    const b = board();
    const w = word || "";
    if (b.editMode === "substitute") {
      cells = Array.from({ length: b.wordLength }, (_, i) =>
        w[i] && w[i] !== " " ? w[i] : "",
      );
    } else {
      buffer = w;
    }
  }

  // The current row's content as a flat string -- for submitting, broadcasting live typing, and
  // comparing against a row's stored word to decide whether it needs (re)committing.
  function rowText() {
    const b = board();
    return b.editMode === "substitute"
      ? cells.map((c) => c || " ").join("")
      : buffer;
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

  function submitCurrentRow() {
    const word = rowText();
    pendingWords[editingIndex] = word;
    Net.send("game_action", {
      gameId: gid,
      action: "set_word",
      // Sent exactly as typed, gaps (placeholder spaces) included -- the server treats a word with
      // any gap, left/internal/right, as not a real word rather than silently closing it up.
      data: { index: editingIndex, word },
    });
  }

  // Changes which row is being edited, re-seeding from that row's stored content. Doesn't submit
  // anything itself -- callers decide whether the row being left needs committing first.
  function switchRow(index, desiredCursor) {
    if (!isPlaying() || index < 1 || index > maxEditableIndex()) return;
    const b = board();
    if (index !== editingIndex) {
      const row = myRows()[index];
      seedRow(row ? row.word : "");
    }
    editingIndex = index;
    // Substitute mode's boxes are a fixed grid; insert/delete mode is a real caret with no
    // fixed length.
    const maxCur = b.editMode === "substitute" ? b.wordLength : buffer.length;
    cursorPos = Math.max(0, Math.min(desiredCursor, maxCur));
    renderBoard();
    sendTyping();
  }

  // Arrow-key and click/tap navigation: commit whatever's typed in the row being left (so it's
  // never silently lost by moving away without pressing Enter), then switch. Skipped if nothing
  // actually changed, so just passing through a row doesn't post a no-op edit.
  function focusRow(index, desiredCursor) {
    if (index !== editingIndex && editingIndex !== null) {
      const storedWord = (myRows()[editingIndex] || {}).word || "";
      if (rowText() !== storedWord) submitCurrentRow();
    }
    switchRow(index, desiredCursor);
  }

  function selectCell(rowIndex, cellIndex) {
    focusRow(rowIndex, cellIndex);
  }

  function input(key) {
    if (!isPlaying() || editingIndex === null) return;
    const b = board();
    const substitute = b.editMode === "substitute";
    if (substitute && cells.length !== b.wordLength) {
      cells = Array(b.wordLength).fill("");
    }
    // The virtual keyboard's friendly action-name for its dedicated SPACE button -- translated
    // to the literal character once, here, so everything below just treats it like any other key.
    if (key === "space") key = " ";

    if (key === "enter") {
      submitCurrentRow();
      // Substitute mode's boxes are an overwrite grid -- the next row starts fresh at the first
      // box; insert/delete mode has a real end-of-text to pick up after.
      switchRow(
        Math.min(editingIndex + 1, maxEditableIndex()),
        substitute ? 0 : Infinity,
      );
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
      const maxCur = substitute ? b.wordLength : buffer.length;
      cursorPos = Math.min(maxCur, cursorPos + 1);
      renderBoard();
      return;
    }
    if (key === "back") {
      if (substitute) {
        // The cursor sits *before* the box at cursorPos, same as any text caret -- backspace
        // always clears the box just behind it, never the one it's currently sitting on (that
        // would read as deleting forward). One rule, no cases.
        if (cursorPos > 0) {
          cursorPos -= 1;
          cells[cursorPos] = "";
        }
      } else {
        if (cursorPos === 0) return;
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos -= 1;
      }
    } else if (/^[a-z]$/.test(key)) {
      if (substitute) {
        // Any box can be clicked/arrowed to directly and typed into -- this always overwrites
        // exactly that box, whether it was empty or already held a letter.
        if (cursorPos >= b.wordLength) return;
        cells[cursorPos] = key;
        cursorPos = Math.min(b.wordLength, cursorPos + 1);
      } else {
        if (buffer.length >= 24) return;
        buffer = buffer.slice(0, cursorPos) + key + buffer.slice(cursorPos);
        cursorPos += 1;
      }
    } else if (key === " ") {
      // Only a legal character in insert/delete mode -- substitute mode's boxes hold letters
      // only, and there's no physical-keyboard spacebar handling wired for substitute games.
      if (substitute || buffer.length >= 24) return;
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
        data: { text: rowText(), index: editingIndex },
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
      cells,
      buffer,
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
