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
  let typingPeer = null; // {name, text} from another player, shown when my buffer is empty
  let lastTypingSent = 0;

  function init(refs) {
    els = refs;
    Board.mount(els.board);
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
    typingPeer = null;
  }

  function reset() {
    gid = null;
    snap = null;
    buffer = "";
    pending = null;
    rejectMsg = null;
    prevRows = 0;
    typingPeer = null;
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
      typingPeer = null;
      prevRows = s.board.rows.length;
    }
    render();
  }

  function onFeed(ev) {
    if (ev.kind === "typing") {
      typingPeer = { name: ev.name, text: ev.text || "" };
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
    if (reason === "length") return "guesses must be 5 letters";
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

  function sendTyping() {
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
    const current = buffer.length
      ? buffer
      : pending
        ? pending
        : typingPeer
          ? typingPeer.text
          : "";
    Board.render({
      rows: b.rows,
      current,
      wordLength: b.wordLength,
      maxGuesses: b.maxGuesses,
    });
  }

  function renderPlayers() {
    if (!snap.players.length) {
      els.players.innerHTML = "";
      return;
    }
    const parts = snap.players.map((p) => {
      const style = safeColor(p.color) ? ` style="color:${p.color}"` : "";
      return `<span class="dot"${style}>●</span>${escapeHtml(p.name)}`;
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
    if (typingPeer && !buffer.length && isPlaying()) {
      lines.push(`<div class="typing">${typingPeer.name} is typing…</div>`);
    }
    els.feed.innerHTML = lines.join("");
  }

  function render() {
    renderBoard();
    renderPlayers();
    renderStatus();
    renderFeed();
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
