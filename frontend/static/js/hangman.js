// Client controller for cooperative Hangman. Much simpler than Wordle's: a letter click is an
// immediate guess (no buffer/backspace/enter, no retry/dedup needed — see hangman.py, guesses are
// naturally idempotent), and there's no live-typing sharing to wire up. Renders the gallows figure,
// masked word, players, feed, and keyboard from each authoritative snapshot.
const Hangman = (() => {
  let els = {};
  let myId = null;
  let gid = null;
  let snap = null;

  function init(refs) {
    els = refs;
    if (els.revealBtn) {
      els.revealBtn.addEventListener("click", () => {
        Net.send("game_action", { gameId: gid, action: "reveal", data: {} });
      });
    }
    setUpStrokeLengths();
  }

  function setMyId(id) {
    myId = id;
  }

  function open(gameId) {
    gid = gameId;
    resetFigure(); // start each opened game (new or rejoined) from a blank gallows
  }

  function reset() {
    gid = null;
    snap = null;
  }

  function board() {
    return snap ? snap.board : null;
  }
  function isPlaying() {
    const b = board();
    return !!b && (b.status === "playing" || b.status === "lost");
  }

  function applySnapshot(s) {
    if (s.id !== gid) return;
    snap = s;
    render();
  }

  function onFeed() {
    // Hangman has no live-typing/sharing feed events to react to.
  }

  function input(letter) {
    if (!isPlaying()) return;
    if (!/^[a-z]$/.test(letter)) return;
    Net.send("game_action", {
      gameId: gid,
      action: "guess_letter",
      data: { letter },
    });
  }

  function onRejected() {
    // Already-guessed/invalid-letter rejections are rare (the keyboard disables guessed letters
    // client-side already) and self-explanatory from the unchanged board — nothing to show.
  }

  // --- rendering ---
  // Drawn one stage at a time as wrong guesses accumulate — nothing at all (not even the
  // gallows) until the first wrong guess, then gallows base, then pole, then beam, then noose, then the
  // stick figure piece by piece. One stage per wrong guess, so this must have exactly
  // MAX_WRONG (10, see hangman.py) entries.
  const FIGURE_STAGES = [
    ["hm-base"],
    ["hm-pole"],
    ["hm-beam"],
    ["hm-rope"],
    ["hm-head"],
    ["hm-torso"],
    ["hm-arm-l"],
    ["hm-arm-r"],
    ["hm-leg-l"],
    ["hm-leg-r"],
  ];

  // Each .hm-part is an SVG <path>/<circle> with a fixed shape — measure its own length once and
  // pin stroke-dasharray/dashoffset to it, so the CSS "stroke-dashoffset -> 0" transition (see
  // wordplay.css) draws the stroke in from nothing, instead of just fading in. Longer strokes get
  // a longer transition-duration so they take a touch longer to "draw" than short ones.
  function setUpStrokeLengths() {
    if (!els.figure) return;
    const durations = {}; // hm-<part> class -> its own draw duration in seconds
    els.figure.querySelectorAll(".hm-part").forEach((part) => {
      let length;
      try {
        length = part.getTotalLength();
      } catch (_) {
        return; // SVGGeometryElement unsupported — leave the part statically visible
      }
      part.style.strokeDasharray = String(length);
      // A CSS custom property, not the stroke-dashoffset longhand directly: an inline *longhand*
      // always wins over a stylesheet rule regardless of specificity, which would make the
      // .is-drawn class's "stroke-dashoffset: 0" rule unable to ever override it. The base
      // .hm-part rule reads var(--dash-len) instead, so .is-drawn can win normally.
      part.style.setProperty("--dash-len", String(length));
      const duration = Math.min(1.2, Math.max(0.3, length / 150));
      part.style.transitionDuration = `${duration.toFixed(2)}s`;
      const specific = Array.from(part.classList).find((c) => c !== "hm-part");
      if (specific) durations[specific] = duration;
    });

    // A wrong guess that draws two parts at once (e.g. both arms, or the gallows post's two
    // beams) should still read as two separate pencil strokes, not one wide simultaneous one:
    // delay each part after the first by the cumulative duration of the parts before it in its
    // stage, so each starts only once the previous one has actually finished drawing.
    FIGURE_STAGES.forEach((classes) => {
      let delay = 0;
      for (const cls of classes) {
        const part = els.figure.querySelector(`.${cls}`);
        if (part) part.style.transitionDelay = `${delay.toFixed(2)}s`;
        delay += durations[cls] || 0;
      }
    });
  }

  function resetFigure() {
    if (!els.figure) return;
    els.figure
      .querySelectorAll(".hm-part")
      .forEach((p) => p.classList.remove("is-drawn"));
  }

  function renderFigure() {
    const b = board();
    if (!els.figure || !b) return;
    const wrongCount = b.wrongCount || 0;
    // classList.toggle(cls, bool) is idempotent — a redundant render with the same wrongCount
    // never restarts an already-finished draw-in transition, and a fresh game (wrongCount back
    // to 0) correctly un-draws everything (resetFigure() also does this immediately on open()
    // so there's no visible flash of the previous game's figure first).
    FIGURE_STAGES.forEach((classes, i) => {
      const drawn = i < wrongCount;
      for (const cls of classes) {
        const part = els.figure.querySelector(`.${cls}`);
        if (part) part.classList.toggle("is-drawn", drawn);
      }
    });
  }

  function renderWord() {
    const b = board();
    if (!els.word || !b) return;
    // b.word is only present once finished (won/revealed) — show it in full then, since a
    // reveal needn't have every letter guessed the way a win does (where maskedWord already
    // matches the full word).
    const text = b.word || b.maskedWord;
    els.word.textContent = text.toUpperCase().split("").join(" ");
  }

  function renderPlayers() {
    if (!els.players) return;
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
    if (!els.status || !b) return;
    if (b.status === "won") els.status.textContent = "🎉 SOLVED!";
    else if (b.status === "revealed") els.status.textContent = "word revealed";
    else if (b.status === "lost")
      els.status.textContent = "out of guesses — keep going or reveal";
    else els.status.textContent = `${b.wrongCount} of ${b.maxGuesses} wrong`;
  }

  function fmtFeed(ev) {
    if (ev.kind === "win")
      return `🎉 ${ev.name} solved it — ${ev.word.toUpperCase()}`;
    if (ev.kind === "lose")
      return "out of guesses — keep going, or reveal the word";
    if (ev.kind === "revealed")
      return `${ev.name} revealed it — ${ev.word.toUpperCase()}`;
    if (ev.kind === "letter_guess")
      return `${ev.name}: ${ev.letter.toUpperCase()} ${ev.correct ? "✓" : "✗"}`;
    return "";
  }

  function renderFeed() {
    if (!els.feed) return;
    const durable = snap.feed.filter((e) => e.kind !== "typing");
    const last = durable[durable.length - 1];
    els.feed.innerHTML = last ? `<div>${fmtFeed(last)}</div>` : "";
  }

  function renderRevealRow() {
    const b = board();
    if (!els.revealRow) return;
    els.revealRow.hidden = !b || b.status !== "lost";
  }

  function render() {
    renderFigure();
    renderWord();
    renderPlayers();
    renderStatus();
    renderFeed();
    renderRevealRow();
    if (els.delete) els.delete.hidden = !(snap.owner && snap.owner === myId);
    const b = board();
    if (els.keyboard && b) {
      const hints = {};
      for (const l of b.guessed)
        hints[l] = b.wrongLetters.includes(l) ? "miss" : "hit";
      els.keyboard.setHints(hints);
      els.keyboard.setDisabled(b.guessed);
    }
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
