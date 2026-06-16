// Global activity log: collects events broadcast by the server and renders them in a scrollable
// panel. On wide screens (≥960 px) the panel is a permanent sidebar; on narrow screens it is a
// full-screen overlay opened with the floating LOG button.
const Activity = (() => {
  let events = [];
  let showRejected = false;
  let els = {};

  function init(refs) {
    els = refs;

    // Filter checkbox: unchecked = hide rejected (default), checked = show all.
    els.filter.addEventListener("change", () => {
      showRejected = els.filter.checked;
      render();
    });

    // Narrow-screen open/close.
    els.toggle.addEventListener("click", () =>
      els.panel.classList.add("is-open"),
    );
    els.close.addEventListener("click", () =>
      els.panel.classList.remove("is-open"),
    );
  }

  // Replace the full event list (called on welcome with the server's stored history).
  function load(evts) {
    events = evts || [];
    render();
  }

  // Append a single new event (real-time broadcast).
  function push(ev) {
    events.push(ev);
    render();
  }

  function render() {
    const visible = showRejected
      ? events
      : events.filter((e) => e.kind !== "rejected");
    if (!visible.length) {
      els.list.innerHTML = '<p class="aev-empty">no moves yet</p>';
      return;
    }
    els.list.innerHTML = visible.map(fmtEvent).join("");
    els.list.scrollTop = els.list.scrollHeight;
  }

  function fmtEvent(ev) {
    const ts = fmtTime(ev.ts);
    const n = esc(ev.name || "?");
    const w = esc((ev.word || "").toUpperCase());
    const a = esc((ev.answer || "").toUpperCase());
    const dot = colorDot(ev.color);
    let body;
    switch (ev.kind) {
      case "game_created":
        body = `${dot}<b>${n}</b> started a Wordle`;
        break;
      case "player_joined":
        body = `${dot}<b>${n}</b> joined`;
        break;
      case "guess":
        body = `${dot}<b>${n}</b>: ${w} ${marks(ev.marks)}`;
        break;
      case "game_won":
        body = `${dot}<b>${n}</b> solved it — ${w} ${marks(ev.marks)}`;
        break;
      case "game_lost":
        body = `game over — the word was <b>${a}</b>`;
        break;
      case "rejected":
        body = `${dot}<b>${n}</b>: ${w} — ${esc(rejectReason(ev.reason))}`;
        break;
      default:
        body = esc(ev.kind || "");
    }
    const extra =
      ev.kind === "rejected"
        ? " aev-rejected"
        : ev.kind === "game_won"
          ? " aev-won"
          : "";
    return (
      `<div class="aev${extra}">` +
      `<span class="aev-ts">${esc(ts)}</span>` +
      `<span class="aev-body">${body}</span>` +
      `</div>`
    );
  }

  function marks(arr) {
    return (arr || [])
      .map((m) => (m === "hit" ? "🟩" : m === "present" ? "🟨" : "⬜"))
      .join("");
  }

  function rejectReason(r) {
    if (r === "length") return "wrong length";
    if (r === "finished") return "game is over";
    return "not in word list";
  }

  function colorDot(color) {
    const style = safeColor(color) ? ` style="color:${color}"` : "";
    return `<span class="dot"${style}>●</span>`;
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : str;
    return d.innerHTML;
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c || "") ? c : "";
  }

  return { init, load, push };
})();
