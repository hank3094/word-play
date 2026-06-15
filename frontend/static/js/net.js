// Single WebSocket client: connect, typed send, and a {type -> handlers[]} dispatch registry.
// A periodic ping keeps the server-side presence TTL fresh. There is no auto-reconnect beyond
// re-sending hello when the lobby reopens the socket.
const Net = (() => {
  let ws = null;
  let name = "PLAYER";
  let pingTimer = null;
  const handlers = {};
  let statusCb = null;

  function setStatus(s) {
    if (statusCb) statusCb(s);
  }

  function connect(playerName) {
    name = playerName;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      send("set_name", { name });
      return;
    }
    ws = new WebSocket(API.wsUrl());
    ws.onopen = () => {
      send("hello", { name });
      setStatus("connected");
      startPing();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      (handlers[msg.type] || []).forEach((h) => h(msg));
    };
    ws.onclose = () => {
      setStatus("disconnected");
      stopPing();
    };
    ws.onerror = () => setStatus("connection error");
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
