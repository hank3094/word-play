// Thin REST + WebSocket-URL helpers. Gameplay is over the socket; these are for page-load extras.
const API = (() => {
  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  return {
    // ws:// or wss:// back to the serving origin.
    wsUrl: (path = "/ws/play/") =>
      `${location.protocol === "https:" ? "wss" : "ws"}://${
        location.host
      }${path}`,
    getHistory: () => getJSON("/api/history"),
    getGameTypes: () => getJSON("/api/game-types"),
  };
})();
