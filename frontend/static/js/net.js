// Single WebSocket client: connect, typed send, and a {type -> handlers[]} dispatch registry.
// A periodic ping keeps the server-side presence TTL fresh. If the socket drops (server restart,
// laptop sleep, network blip) it auto-reconnects with backoff and re-sends hello — otherwise every
// action after a drop would silently no-op (send() only fires on an open socket).
const Net = (() => {
  let ws = null;
  let name = "PLAYER";
  let cid = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let wantConnection = false; // true once connect() is called; keeps us reconnecting
  const handlers = {};
  let statusCb = null;

  function setStatus(s) {
    if (statusCb) statusCb(s);
  }

  // A stable per-browser id so a refresh / second tab is recognised as the same player rather than
  // spawning a duplicate in the lobby.
  function clientId() {
    let id = localStorage.getItem("wp-cid");
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        String(Math.random()).slice(2);
      localStorage.setItem("wp-cid", id);
    }
    return id;
  }

  function connect(playerName) {
    name = playerName;
    cid = clientId();
    wantConnection = true;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      send("set_name", { name });
      return;
    }
    openSocket();
  }

  function openSocket() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    ws = new WebSocket(API.wsUrl());
    ws.onopen = () => {
      reconnectDelay = 1000; // reset backoff on a good connection
      send("hello", { name, cid });
      setStatus("connected");
      startPing();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      (handlers[msg.type] || []).forEach((h) => h(msg));
    };
    ws.onclose = () => {
      stopPing();
      if (!wantConnection) {
        setStatus("disconnected");
        return;
      }
      setStatus("reconnecting…");
      scheduleReconnect();
    };
    // onerror is always followed by onclose, which handles the reconnect.
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000); // 1s,2s,4s,8s,10s…
  }

  function send(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  function on(type, handler) {
    (handlers[type] = handlers[type] || []).push(handler);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send("ping"), 20000);
  }
  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  return {
    connect,
    send,
    on,
    setStatusCb: (cb) => (statusCb = cb),
    myName: () => name,
  };
})();
