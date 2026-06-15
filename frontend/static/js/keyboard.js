// On-screen QWERTY with ENTER and ⌫. Touch + click friendly; also the visual home for colour
// hints. Physical-keyboard input is handled in app.js and funnelled through the same onKey callback.
const Keyboard = (() => {
  const ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["enter", "z", "x", "c", "v", "b", "n", "m", "back"],
  ];
  const LABEL = { enter: "ENTER", back: "⌫" };

  let root = null;
  let onKey = () => {};
  const keyEls = {};

  function render(el, cb) {
    root = el;
    onKey = cb || (() => {});
    root.innerHTML = "";
    for (const row of ROWS) {
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
      root.appendChild(rowEl);
    }
  }

  // hints: { letter: "hit" | "present" | "miss" }
  function setHints(hints) {
    for (const [key, btn] of Object.entries(keyEls)) {
      btn.classList.remove("hit", "present", "miss");
      const mark = hints && hints[key];
      if (mark) btn.classList.add(mark);
    }
  }

  return { render, setHints };
})();
