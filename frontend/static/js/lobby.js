// Renders the lobby: who's online, which games are active (with an OPEN button), and a recent
// history strip. Emits intent through callbacks wired in app.js (create / open a game).
const Lobby = (() => {
  let els = {};
  let onOpen = () => {};
  let onDelete = () => {};
  let myId = null;

  let onOpenHistory = () => {};

  function init(refs, handlers) {
    els = refs;
    onOpen = handlers.onOpen;
    onDelete = handlers.onDelete || (() => {});
    onOpenHistory = handlers.onOpenHistory || (() => {});
  }

  function setMyId(id) {
    myId = id;
  }

  function renderPlayers(players) {
    els.players.innerHTML = "";
    if (!players.length) {
      els.players.innerHTML = '<li class="empty">nobody here yet</li>';
      return;
    }
    for (const p of players) {
      const li = document.createElement("li");
      const you = p.id === myId ? " (you)" : "";
      const dotStyle = safeColor(p.color) ? ` style="color:${p.color}"` : "";
      li.innerHTML = `<span><span class="dot"${dotStyle}>●</span>${escapeHtml(
        p.name,
      )}${you}</span>`;
      els.players.appendChild(li);
    }
  }

  function renderGames(games) {
    els.games.innerHTML = "";
    if (!games.length) {
      els.games.innerHTML = '<li class="empty">no games yet — start one!</li>';
      return;
    }
    for (const g of games) {
      const li = document.createElement("li");
      li.className = "game-row";
      const label = g.gameType.toUpperCase();
      const who = g.players.length ? g.players.join(", ") : "empty";
      const statusBadge =
        g.status === "playing"
          ? `<span class="meta">${g.count} playing</span>`
          : `<span class="badge ${g.status}">${g.status}</span>`;
      li.innerHTML =
        `<span><b>${label}</b> <span class="meta">— ${escapeHtml(
          who,
        )}</span></span>` + `<span class="row-right">${statusBadge}</span>`;
      const right = li.querySelector(".row-right");
      const btn = document.createElement("button");
      btn.className = "btn btn-small";
      btn.textContent = "OPEN";
      btn.addEventListener("click", () => onOpen(g.id));
      right.appendChild(btn);
      // Only the game's owner sees a delete control.
      if (g.owner && g.owner === myId) {
        const del = document.createElement("button");
        del.className = "btn btn-small btn-danger btn-icon";
        del.title = "delete game";
        del.textContent = "✕";
        del.addEventListener("click", () => onDelete(g.id));
        right.appendChild(del);
      }
      els.games.appendChild(li);
    }
  }

  function renderHistory(history) {
    els.history.innerHTML = "";
    if (!history || !history.length) {
      els.history.innerHTML = '<li class="empty">no finished games yet</li>';
      return;
    }
    for (const h of history.slice(0, 8)) {
      const li = document.createElement("li");
      const outcome = h.won ? "won" : "lost";
      const viewBtn =
        h.hasSnapshot && h.gameId
          ? `<button class="btn btn-small history-view" data-gid="${escapeHtml(
              h.gameId,
            )}">VIEW</button>`
          : "";
      li.innerHTML =
        `<span><b>${escapeHtml(h.answer.toUpperCase())}</b> ` +
        `<span class="meta">${escapeHtml(
          (h.players || []).join(", "),
        )}</span></span>` +
        `<span class="badge ${outcome}">${outcome} ${h.guessesUsed}/6</span>` +
        viewBtn;
      els.history.appendChild(li);
    }
    els.history.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest(".history-view");
        if (btn) onOpenHistory(btn.dataset.gid);
      },
      { once: true },
    );
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : str;
    return d.innerHTML;
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c || "") ? c : "";
  }

  return { init, setMyId, renderPlayers, renderGames, renderHistory };
})();
