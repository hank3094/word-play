// Global activity log: collects events broadcast by the server and renders them in a scrollable
// panel. On wide screens (≥960 px) the panel is a permanent sidebar; on narrow screens it is a
// full-screen overlay opened with the floating LOG button.
const Activity = (() => {
  const WIDE = 960;
  const PW_KEY = "wp-panel-w";
  const PH_KEY = "wp-panel-hidden";
  const MIN_W = 160;
  const MAX_W = 520;
  const DEFAULT_W = 270;

  let events = [];
  let showRejected = false;
  let filterToGame = false;
  let currentGame = null;
  let onOpenGame = () => {};
  let onFetchActivity = () => {};
  let els = {};
  let panelW = DEFAULT_W;

  // Pagination state
  let serverOffset = 0; // next offset to request from the server
  let hasMore = false; // server has older entries beyond what we've loaded
  let fetching = false; // a fetch_activity request is in-flight
  let prependNext = false; // next render should preserve scroll position (not jump to bottom)
  let seenIds = new Set(); // dedup live-push vs. historical overlap

  // --- panel width / collapse helpers ---

  function _applyWidth(w) {
    document.documentElement.style.setProperty("--activity-w", w + "px");
  }
  function _collapse() {
    _applyWidth(0);
    els.panel.classList.add("is-collapsed");
    localStorage.setItem(PH_KEY, "1");
  }
  function _expand() {
    _applyWidth(panelW);
    els.panel.classList.remove("is-collapsed");
    localStorage.removeItem(PH_KEY);
  }
  function _restoreState() {
    const saved = parseInt(localStorage.getItem(PW_KEY) || "", 10);
    panelW = saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W;
    if (localStorage.getItem(PH_KEY)) {
      _collapse();
    } else {
      _applyWidth(panelW);
    }
  }

  // --- init ---

  function init(refs, handlers) {
    els = refs;
    onOpenGame = (handlers && handlers.onOpenGame) || (() => {});
    onFetchActivity = (handlers && handlers.onFetchActivity) || (() => {});

    _restoreState();

    els.filter.addEventListener("change", () => {
      showRejected = els.filter.checked;
      render();
    });
    els.gameFilter.addEventListener("change", () => {
      filterToGame = els.gameFilter.checked;
      render();
    });

    els.toggle.addEventListener("click", () => {
      if (window.innerWidth >= WIDE) {
        _expand();
      } else {
        els.panel.classList.add("is-open");
      }
    });
    els.close.addEventListener("click", () => {
      if (window.innerWidth >= WIDE) {
        _collapse();
      } else {
        els.panel.classList.remove("is-open");
      }
    });

    els.list.addEventListener("click", (e) => {
      const btn = e.target.closest(".aev-jump");
      if (btn) {
        onOpenGame(btn.dataset.gid);
        els.panel.classList.remove("is-open");
      }
    });

    // Scroll-to-top triggers loading older entries.
    els.list.addEventListener("scroll", () => {
      if (els.list.scrollTop < 8 && hasMore && !fetching) {
        fetching = true;
        prependNext = true;
        onFetchActivity(serverOffset);
      }
    });

    if (els.resizer) {
      els.resizer.addEventListener("mousedown", (e) => {
        if (window.innerWidth < WIDE) return;
        e.preventDefault();
        els.resizer.classList.add("dragging");
        const onMove = (ev) => {
          const w = Math.max(
            MIN_W,
            Math.min(MAX_W, window.innerWidth - ev.clientX),
          );
          panelW = w;
          _applyWidth(w);
        };
        const onUp = () => {
          els.resizer.classList.remove("dragging");
          localStorage.setItem(PW_KEY, String(panelW));
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
  }

  // --- public API ---

  function setCurrentGame(gid) {
    currentGame = gid;
    filterToGame = !!gid;
    els.gameFilter.checked = filterToGame;
    els.gameFilterRow.hidden = !gid;
    render();
  }

  // Called with server history. offset=0 → initial load (replace); offset>0 → prepend older batch.
  function load(evts, offset, more) {
    fetching = false;
    hasMore = !!more;

    if (offset === 0) {
      // Full replacement: rebuild seenIds from scratch so future live pushes still dedup correctly.
      events = evts || [];
      seenIds = new Set(events.map((e) => e.id).filter(Boolean));
      serverOffset = events.length;
      prependNext = false;
    } else {
      // Prepending older page: only skip ids we already have.
      const incoming = (evts || []).filter((e) => !seenIds.has(e.id));
      incoming.forEach((e) => e.id && seenIds.add(e.id));
      events = incoming.concat(events);
      serverOffset = offset + incoming.length;
    }
    render();
  }

  // Real-time single event push.
  function push(ev) {
    if (ev.id && seenIds.has(ev.id)) return;
    if (ev.id) seenIds.add(ev.id);
    events.push(ev);
    render();
  }

  // --- rendering ---

  function render() {
    let visible = events.filter((e) => e.kind !== "player_joined");
    if (filterToGame && currentGame) {
      visible = visible.filter((e) => !e.gameId || e.gameId === currentGame);
    }
    if (!showRejected) {
      visible = visible.filter((e) => e.kind !== "rejected");
    }

    const topRow = hasMore
      ? '<p class="aev-load-more">' +
        (fetching ? "loading…" : "↑ scroll for older entries") +
        "</p>"
      : "";

    if (!visible.length) {
      els.list.innerHTML = topRow + '<p class="aev-empty">no moves yet</p>';
      return;
    }

    if (prependNext) {
      // Preserve scroll position after prepending so viewport doesn't jump.
      const prevH = els.list.scrollHeight;
      els.list.innerHTML = topRow + visible.map(fmtEvent).join("");
      els.list.scrollTop = els.list.scrollHeight - prevH;
      prependNext = false;
    } else {
      els.list.innerHTML = topRow + visible.map(fmtEvent).join("");
      els.list.scrollTop = els.list.scrollHeight;
    }
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
      case "player_updated": {
        const oldN = ev.oldName ? esc(ev.oldName) : n;
        const oldDot = colorDot(ev.oldColor || ev.color);
        body = `${oldDot}<b>${oldN}</b> → ${dot}<b>${n}</b>`;
        break;
      }
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

    const canJump = ev.gameId && ev.gameId !== currentGame;
    const jumpBtn = canJump
      ? `<button class="btn btn-small aev-jump" data-gid="${esc(
          ev.gameId,
        )}" title="open this game">→</button>`
      : "";

    return (
      `<div class="aev${extra}">` +
      `<span class="aev-ts">${esc(ts)}</span>` +
      `<span class="aev-body">${body}</span>` +
      jumpBtn +
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

  return { init, load, push, setCurrentGame };
})();
