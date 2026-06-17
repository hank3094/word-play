// Single WebSocket client: connect, typed send, and a {type -> handlers[]} dispatch registry.
// A periodic ping keeps the server-side presence TTL fresh. If the socket drops (server restart,
// laptop sleep, network blip) it auto-reconnects with backoff and re-sends hello — otherwise every
// action after a drop would silently no-op (send() only fires on an open socket).
const Net = (() => {
  let ws = null;
  let name = "PLAYER";
  let color = "";
  let cid = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let wantConnection = false; // true once connect() is called; keeps us reconnecting
  const handlers = {};
  let statusCb = null;
  let pendingCb = null;

  // A single "most recent action fired while disconnected" slot. We never queue: a newer action
  // overwrites the older, so only the latest is replayed once we reconnect. Heartbeat pings and
  // live-typing keystrokes are transient — they'd be stale on replay, so they're dropped instead.
  let pendingAction = null;
  const TRANSIENT = new Set(["ping", "typing"]);

  function setStatus(s) {
    if (statusCb) statusCb(s);
  }

  function setPending(active) {
    if (pendingCb) pendingCb(active);
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

  function connect(playerName, playerColor) {
    name = playerName;
    color = playerColor || "";
    cid = clientId();
    wantConnection = true;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      send("set_name", { name, color });
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
      send("hello", { name, cid, color });
      setStatus("connected");
      startPing();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      (handlers[msg.type] || []).forEach((h) => h(msg));
      // Flush a deferred action on welcome, AFTER its handlers run: the welcome handler re-sends
      // open_game to rejoin the game server-side, which must precede a replayed game_action.
      if (msg.type === "welcome") flushPending();
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
      return;
    }
    // Disconnected. Transient messages are pointless to replay; drop them silently.
    if (TRANSIENT.has(type)) return;
    // Remember only the most recent action and show the spinner until it runs.
    pendingAction = { type, payload };
    setPending(true);
    // Kick an immediate reconnect rather than waiting out the backoff timer.
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      reconnectDelay = 1000;
      openSocket();
    }
  }

  // For a send that *looked* successful (socket reported OPEN) but never got a response — e.g. a
  // "zombie" connection that has gone dead without the browser noticing yet, so close() hasn't
  // fired. The caller (e.g. a guess with no server reply after a timeout) treats that as a dropped
  // send: this forces the old socket closed without waiting for its own close handler to schedule
  // a reconnect (which would race a fresh one), then reconnects immediately and replays the action
  // once the new connection is welcomed.
  function forceRetry(type, payload) {
    pendingAction = { type, payload };
    setPending(true);
    reconnectDelay = 1000;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch (e) {
        // already closed/closing — fine, openSocket() below replaces it
      }
    }
    openSocket();
  }

  function flushPending() {
    if (pendingAction && ws && ws.readyState === WebSocket.OPEN) {
      const { type, payload } = pendingAction;
      ws.send(JSON.stringify({ type, ...payload }));
    }
    if (pendingAction) {
      pendingAction = null;
      setPending(false);
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
    forceRetry,
    on,
    setStatusCb: (cb) => (statusCb = cb),
    setPendingCb: (cb) => (pendingCb = cb),
    myName: () => name,
  };
})();
