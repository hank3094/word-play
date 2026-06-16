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

  function init(refs) {
    els = refs;
    Board.mount(els.board);

    // Personal share toggle: claim or release my own live typing.
    if (els.shareMine) {
      els.shareMine.addEventListener("change", () => {
        Net.send(iAmSharing() ? "share_stop" : "share_start", { gameId: gid });
      });
    }
    // Host-only master switches.
    if (els.allowShare) {
      els.allowShare.addEventListener("change", () => {
        Net.send("set_allow_sharing", {
          gameId: gid,
          allowed: els.allowShare.checked,
        });
      });
    }
    if (els.simulShare) {
      els.simulShare.addEventListener("change", () => {
        Net.send("set_simultaneous", {
          gameId: gid,
          value: els.simulShare.checked,
        });
      });
    }
    // Host stops a specific sharer via the ✕ on their players-list badge.
    if (els.players) {
      els.players.addEventListener("click", (e) => {
        const btn = e.target.closest(".share-stop");
        if (btn)
          Net.send("share_stop", { gameId: gid, targetId: btn.dataset.pid });
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
  }

  function reset() {
    gid = null;
    snap = null;
    buffer = "";
    pending = null;
    rejectMsg = null;
    prevRows = 0;
    typingPeers = {};
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
        Net.send("game_action", {
          gameId: gid,
          action: "guess",
          data: { word: buffer },
        });
        // Clear the buffer immediately so the next word's letters aren't dropped (and a rejected
        // word can't get stuck). Keep it visible as `pending` until the server replies.
        pending = buffer;
        buffer = "";
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
    rejectMsg = rejectText(reason);
    Board.flashInvalid();
    renderFeed();
    setTimeout(() => {
      pending = null;
      renderBoard();
    }, 360);
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
    let current = buffer.length ? buffer : pending ? pending : "";
    let showCursor = !!buffer.length;
    let tint = null;
    let ghosts = null;

    const sharers = (snap && snap.sharers) || [];
    if (snap && snap.simultaneous) {
      // Everyone overlaid: other sharers' letters ghost beneath your own.
      ghosts = sharers
        .filter((pid) => pid !== myId)
        .map((pid) => ({
          text: (typingPeers[pid] || {}).text || "",
          color: colorOf(pid),
        }))
        .filter((g) => g.text);
    } else if (!buffer.length && !pending) {
      // Exclusive mode: an idle viewer mirrors the single sharer, tinted in their colour.
      const sharerPid = sharers.find((pid) => pid !== myId);
      if (sharerPid) {
        current = (typingPeers[sharerPid] || {}).text || "";
        tint = colorOf(sharerPid);
        showCursor = false;
      }
    }

    Board.render({
      rows: b.rows,
      current,
      showCursor,
      tint,
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
    const host = iAmHost();
    const parts = snap.players.map((p) => {
      const style = safeColor(p.color) ? ` style="color:${p.color}"` : "";
      let badge = "";
      if (sharers.includes(p.id)) {
        // The host can stop a specific sharer; everyone else just sees the indicator.
        badge = host
          ? ` <button class="share-stop" data-pid="${escapeHtml(
              p.id,
            )}" title="stop ${escapeHtml(p.name)} sharing">📡✕</button>`
          : ` <span class="share-badge" title="sharing">📡</span>`;
      }
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

  // Personal "share my typing" checkbox + host-only allow/simultaneous checkboxes.
  function renderShareControls() {
    const playing = isPlaying();
    const allow = !!snap.allowSharing;
    const simul = !!snap.simultaneous;
    const mine = iAmSharing();

    if (els.shareMineRow) {
      els.shareMineRow.hidden = !playing || !allow;
      els.shareMine.checked = mine;
      // In exclusive mode you can only claim sharing when nobody else holds it.
      const blocked = !simul && !mine && (snap.sharers || []).length > 0;
      els.shareMine.disabled = blocked;
    }
    if (els.allowShareRow) {
      els.allowShareRow.hidden = !playing || !iAmHost();
      els.allowShare.checked = allow;
    }
    if (els.simulShareRow) {
      els.simulShareRow.hidden = !playing || !iAmHost();
      els.simulShare.checked = simul;
      els.simulShare.disabled = !allow;
    }
  }

  function render() {
    renderBoard();
    renderPlayers();
    renderStatus();
    renderFeed();
    renderShareControls();
    if (els.delete) els.delete.hidden = !(snap.owner && snap.owner === myId);
    Keyboard.setHints(board().keyboard);
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
