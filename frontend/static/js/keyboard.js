// On-screen QWERTY with ENTER and ⌫ (or letters-only, for games with no typed buffer). Touch +
// click friendly; also the visual home for colour hints. Physical-keyboard input is handled in
// app.js and funnelled through the same onKey callback. A factory, not a singleton, since
// multiple game views (Wordle, Hangman) each need their own independent keyboard instance.
const Keyboard = (() => {
  const ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["enter", "z", "x", "c", "v", "b", "n", "m", "back"],
  ];
  const LABEL = { enter: "ENTER", back: "⌫", space: "SPACE" };

  // opts.lettersOnly: omit the ENTER/⌫ keys (for a click-to-guess-immediately game like hangman).
  // opts.allowSpace: add a dedicated full-width SPACE row -- only word-length-indeterminate ladder
  // games need it (it inserts an empty placeholder box), and there's no physical-keyboard
  // equivalent on mobile without an external keyboard, so it has to live somewhere on screen.
  // Built once up front; toggle per-game applicability afterwards with setSpaceVisible.
  function create(el, cb, opts = {}) {
    const onKey = cb || (() => {});
    const keyEls = {};
    const rows = opts.lettersOnly
      ? ROWS.map((row) => row.filter((k) => k !== "enter" && k !== "back"))
      : ROWS;

    el.innerHTML = "";
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "kb-row";
      for (const key of row) {
        const btn = document.createElement("button");
        btn.className =
          "kb-key" + (key === "enter" || key === "back" ? " wide" : "");
        btn.textContent = LABEL[key] || key;
        btn.dataset.key = key;
        btn.addEventListener("click", () => onKey(key));
        rowEl.appendChild(btn);
        keyEls[key] = btn;
      }
      el.appendChild(rowEl);
    }

    if (opts.allowSpace) {
      const rowEl = document.createElement("div");
      rowEl.className = "kb-row";
      const btn = document.createElement("button");
      btn.className = "kb-key wide-space";
      btn.textContent = LABEL.space;
      btn.dataset.key = "space";
      btn.addEventListener("click", () => onKey("space"));
      rowEl.appendChild(btn);
      keyEls.space = btn;
      el.appendChild(rowEl);
    }

    // hints: { letter: "hit" | "present" | "miss" }
    function setHints(hints) {
      for (const [key, btn] of Object.entries(keyEls)) {
        btn.classList.remove("hit", "present", "miss");
        const mark = hints && hints[key];
        if (mark) btn.classList.add(mark);
      }
    }

    // keys: iterable of key strings to disable (e.g. letters already guessed).
    function setDisabled(keys) {
      const disabled = new Set(keys || []);
      for (const [key, btn] of Object.entries(keyEls)) {
        btn.disabled = disabled.has(key);
      }
    }

    // Hides the SPACE row for games/modes where inserting a placeholder makes no sense (e.g.
    // substitute mode, or any non-ladder keyboard that never set opts.allowSpace).
    function setSpaceVisible(visible) {
      if (keyEls.space) keyEls.space.parentElement.hidden = !visible;
    }

    return { setHints, setDisabled, setSpaceVisible };
  }

  return { create };
})();
