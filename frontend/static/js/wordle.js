// Client controller for cooperative Wordle. Holds the local typing buffer, renders each
// authoritative snapshot (shared board, players, feed, keyboard hints), shows other players' live
// typing, and turns input into game_action messages. It is fully re-rendered from each snapshot, so
// the server stays authoritative.
const Wordle = (() => {
  let els = {};
  let gid = null;
  let snap = null;
  let buffer = "";
  let prevRows = 0;
  let typingPeer = null; // {name, text} from another player, shown when my buffer is empty
  let lastTypingSent = 0;

  function init(refs) {
    els = refs;
    Board.mount(els.board);
  }

  function open(gameId) {
    gid = gameId;
    buffer = "";
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
      } else {
        Board.flashInvalid();
      }
      return;
    }
    if (key === "back") {
      buffer = buffer.slice(0, -1);
    } else if (/^[a-z]$/.test(key) && buffer.length < len) {
      buffer += key;
    } else {
      return;
    }
    renderBoard();
    sendTyping();
  }

  function onRejected() {
    Board.flashInvalid();
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
    const current = buffer.length ? buffer : typingPeer ? typingPeer.text : "";
    Board.render({
      rows: b.rows,
      current,
      wordLength: b.wordLength,
      maxGuesses: b.maxGuesses,
    });
  }

  function renderPlayers() {
    const names = snap.players.map((p) => p.name).join(", ");
    els.players.textContent = names ? `with ${names}` : "";
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
    Keyboard.setHints(board().keyboard);
  }

  return {
    init,
    open,
    applySnapshot,
    onFeed,
    input,
    onRejected,
    currentGame: () => gid,
  };
})();
