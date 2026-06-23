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
  const LABEL = { enter: "ENTER", back: "⌫" };

  // opts.lettersOnly: omit the ENTER/⌫ keys (for a click-to-guess-immediately game like hangman).
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

    return { setHints, setDisabled };
  }

  return { create };
})();
