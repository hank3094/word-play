// Client controller for cooperative Wordle. Holds the local typing buffer, renders each
// authoritative snapshot (shared board, players, feed, keyboard hints), shows other players' live
// typing, and turns input into game_action messages. It is fully re-rendered from each snapshot, so
// the server stays authoritative.
const Wordle = (() => {
  let els = {};
  let myId = null;
  let gid = null;
  let snap = null;
  let buffer = "";
  let pending = null; // a guess that's been submitted and is awaiting the server's response
  let rejectMsg = null; // why the last guess was rejected, shown until the next keystroke
  let prevRows = 0;
  let typingPeers = {}; // pid -> {name, text}: other players' live typing (only sharers send it)
  let lastTypingSent = 0;
  let guessAckTimer = null; // watches for a stalled guess send (see armGuessAckTimeout)
  let pendingGuessRequestId = null; // lets a forced retry replay, not duplicate, the same guess
  const GUESS_ACK_TIMEOUT_MS = 5000;

  function init(refs) {
    els = refs;
    Board.mount(els.board);

    // Personal share toggle: claim or release my own live typing.
    if (els.shareToggleBtn) {
      els.shareToggleBtn.addEventListener("click", () => {
        Net.send(iAmSharing() ? "share_stop" : "share_start", { gameId: gid });
      });
    }
    // Host-only master switch, in the settings modal.
    if (els.settingsAllowSharing) {
      els.settingsAllowSharing.addEventListener("change", () => {
        Net.send("set_allow_sharing", {
          gameId: gid,
          allowed: els.settingsAllowSharing.checked,
        });
      });
    }
  }

  function setMyId(id) {
    myId = id;
  }

  function open(gameId) {
    gid = gameId;
    buffer = "";
    pending = null;
    rejectMsg = null;
    prevRows = 0;
    typingPeers = {};
    clearGuessAckTimeout();
    pendingGuessRequestId = null;
  }

  function reset() {
    gid = null;
    snap = null;
    buffer = "";
    pending = null;
    rejectMsg = null;
    prevRows = 0;
    typingPeers = {};
    clearGuessAckTimeout();
    pendingGuessRequestId = null;
  }

  function board() {
    return snap ? snap.board : null;
  }
  function isPlaying() {
    return board() && board().status === "playing";
  }

  function applySnapshot(s) {
    if (s.id !== gid) return;
    snap = s;
    if (s.board.rows.length !== prevRows) {
      // a guess landed (mine or someone else's) — the active row advanced
      buffer = "";
      pending = null;
      rejectMsg = null;
      typingPeers = {};
      prevRows = s.board.rows.length;
      clearGuessAckTimeout();
      pendingGuessRequestId = null;
    }
    render();
  }

  function onFeed(ev) {
    if (ev.kind === "typing") {
      typingPeers[ev.pid] = { name: ev.name, text: ev.text || "" };
      renderBoard();
      renderFeed();
    }
  }

  function input(key) {
    if (!isPlaying()) return;
    const len = board().wordLength;
    if (key === "enter") {
      if (buffer.length === len) {
        // Clear the buffer immediately so the next word's letters aren't dropped (and a rejected
        // word can't get stuck). Keep it visible as `pending` until the server replies.
        pending = buffer;
        buffer = "";
        // Identifies this exact submission so a forced retry (see sendGuess) replays the same
        // request rather than the server mistaking it for a fresh guess and double-counting it.
        pendingGuessRequestId =
          (crypto.randomUUID && crypto.randomUUID()) ||
          `${Date.now()}-${Math.random()}`;
        sendGuess(pending);
        renderBoard();
      } else {
        Board.flashInvalid();
      }
      return;
    }
    pending = null; // composing a fresh guess
    rejectMsg = null; // clear any "not a word" note once they start retyping
    if (key === "back") {
      buffer = buffer.slice(0, -1);
    } else if (/^[a-z]$/.test(key) && buffer.length < len) {
      buffer += key;
    } else {
      return;
    }
    renderBoard();
    renderFeed();
    sendTyping();
  }

  function rejectText(reason) {
    const w = (pending || "").toUpperCase();
    if (reason === "length")
      return `guesses must be ${board().wordLength} letters`;
    if (reason === "finished") return "this game is already over";
    // "unknown" or anything else: the word isn't in our list
    return w ? `“${w}” isn’t in the word list` : "that isn’t in the word list";
  }

  function onRejected(reason) {
    // The submitted word wasn't accepted: flash it, explain why, then drop it so the user can type
    // a fresh guess. The explanation stays until they start retyping.
    clearGuessAckTimeout();
    pendingGuessRequestId = null;
    rejectMsg = rejectText(reason);
    Board.flashInvalid();
    renderFeed();
    setTimeout(() => {
      pending = null;
      renderBoard();
    }, 360);
  }

  // Submit a guess, and watch for it landing. If the server hasn't responded (a new snapshot row,
  // or a rejection) within GUESS_ACK_TIMEOUT_MS, the send likely silently failed — e.g. a "zombie"
  // socket that reports open but is actually dead, so the usual reconnect-and-replay (Net.send's
  // disconnected-queue path) never kicks in. Force a fresh connection and resend in that case.
  function sendGuess(word) {
    Net.send("game_action", {
      gameId: gid,
      action: "guess",
      data: { word, requestId: pendingGuessRequestId },
    });
    armGuessAckTimeout(word);
  }

  function armGuessAckTimeout(word) {
    clearGuessAckTimeout();
    guessAckTimer = setTimeout(() => {
      if (pending !== word) return; // already resolved by the time the timeout fires
      // Same requestId as the original send: the server treats this as a replay of the same
      // guess (see wordle.py's duplicate check) rather than a second, distinct guess.
      Net.forceRetry("game_action", {
        gameId: gid,
        action: "guess",
        data: { word, requestId: pendingGuessRequestId },
      });
      armGuessAckTimeout(word); // keep watching in case the retry also stalls
    }, GUESS_ACK_TIMEOUT_MS);
  }

  // Only clears the watchdog timer — NOT pendingGuessRequestId, which armGuessAckTimeout's retry
  // still needs to read after rearming (it calls this first thing). Callers that know the guess
  // has fully resolved clear pendingGuessRequestId themselves.
  function clearGuessAckTimeout() {
    if (guessAckTimer) {
      clearTimeout(guessAckTimer);
      guessAckTimer = null;
    }
  }

  // --- sharing helpers ---
  function iAmSharing() {
    return !!snap && (snap.sharers || []).includes(myId);
  }
  function iAmHost() {
    return !!snap && snap.owner === myId;
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
        data: { text: buffer },
      });
    }
  }

  // --- rendering ---
  function renderBoard() {
    const b = board();
    if (!b) return;

    // Your own letters are always solid and on top; the cursor shows only while you type.
    const current = buffer.length ? buffer : pending ? pending : "";
    const showCursor = !!buffer.length;
    // You only see others' live typing while you're sharing yours too.
    let ghosts = null;
    if (iAmSharing()) {
      const sharers = (snap && snap.sharers) || [];
      ghosts = sharers
        .filter((pid) => pid !== myId)
        .map((pid) => ({
          text: (typingPeers[pid] || {}).text || "",
          color: colorOf(pid),
        }))
        .filter((g) => g.text);
    }

    Board.render({
      rows: b.rows,
      current,
      showCursor,
      ghosts,
      wordLength: b.wordLength,
      maxGuesses: b.maxGuesses,
    });
  }

  function renderPlayers() {
    if (!snap.players.length) {
      els.players.innerHTML = "";
      return;
    }
    const sharers = snap.sharers || [];
    const parts = snap.players.map((p) => {
      const style = safeColor(p.color) ? ` style="color:${p.color}"` : "";
      const sharing = sharers.includes(p.id);
      const badge = ` <span class="share-badge${
        sharing ? " is-on" : ""
      }" title="${escapeHtml(p.name)} is ${
        sharing ? "sharing" : "not sharing"
      }">📡</span>`;
      return `<span class="dot"${style}>●</span>${escapeHtml(p.name)}${badge}`;
    });
    els.players.innerHTML = parts.join(" ");
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
    if (b.status === "won") els.status.textContent = "🎉 SOLVED!";
    else if (b.status === "lost") els.status.textContent = "out of guesses";
    else
      els.status.textContent = `guess ${b.guessesUsed + 1} of ${b.maxGuesses}`;
  }

  function fmtFeed(ev) {
    if (ev.kind === "win")
      return `🎉 ${ev.name} solved it — ${ev.word.toUpperCase()}`;
    if (ev.kind === "lose") return `the word was ${ev.answer.toUpperCase()}`;
    if (ev.kind === "guess") return `${ev.name}: ${ev.word.toUpperCase()}`;
    return "";
  }

  function renderFeed() {
    const lines = [];
    const durable = snap.feed.filter((e) => e.kind !== "typing");
    const last = durable[durable.length - 1];
    if (last) lines.push(`<div>${fmtFeed(last)}</div>`);
    if (rejectMsg) lines.push(`<div class="reject">${rejectMsg}</div>`);
    els.feed.innerHTML = lines.join("");
  }

  // Personal sharing toggle button + the host-only settings button that opens the settings modal.
  function renderShareControls() {
    const playing = isPlaying();
    const allow = !!snap.allowSharing;
    const mine = iAmSharing();

    if (els.shareToggleBtn) {
      els.shareToggleBtn.hidden = !playing || !allow;
      els.shareToggleBtn.textContent = mine
        ? "📡 SHARING ON"
        : "📡 SHARING OFF";
      els.shareToggleBtn.setAttribute("aria-pressed", String(mine));
      els.shareToggleBtn.classList.toggle("is-on", mine);
    }
    if (els.settingsBtn) {
      els.settingsBtn.hidden = !playing || !iAmHost();
    }
    if (els.settingsAllowSharing) {
      els.settingsAllowSharing.checked = allow;
    }
  }

  function render() {
    renderBoard();
    renderPlayers();
    renderStatus();
    renderFeed();
    renderShareControls();
    if (els.delete) els.delete.hidden = !(snap.owner && snap.owner === myId);
    els.keyboard.setHints(board().keyboard);
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
