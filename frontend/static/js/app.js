// Top-level app: name entry, view routing, WebSocket wiring, and input dispatch. Loads last so all
// the module globals (API, Net, Keyboard, Board, Wordle, Lobby) are defined.
(() => {
  const views = {};
  document.querySelectorAll(".view").forEach((v) => (views[v.id] = v));

  const NAME_KEY = "wp-name";

  function show(id) {
    document
      .querySelectorAll(".view.is-active")
      .forEach((v) => v.classList.remove("is-active"));
    views[id].classList.add("is-active");
  }

  function storedName() {
    return (localStorage.getItem(NAME_KEY) || "").toUpperCase();
  }
  function setName(name) {
    name = (name || "PLAYER").trim().toUpperCase().slice(0, 16) || "PLAYER";
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  // ---- name entry ----
  function wireNameEntry() {
    const form = document.getElementById("name-form");
    const input = document.getElementById("name-input");
    input.value = storedName();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = setName(input.value);
      enterLobby(name);
    });
  }

  // ---- lobby ----
  function enterLobby(name) {
    document.getElementById("you-name").textContent = name;
    Net.connect(name);
    refreshHistory();
    show("lobby");
  }

  async function refreshHistory() {
    try {
      const data = await API.getHistory();
      Lobby.renderHistory(data.history);
    } catch (_) {
      /* offline: leave as-is */
    }
  }

  function wireLobby() {
    Lobby.init(
      {
        players: document.getElementById("players-list"),
        games: document.getElementById("games-list"),
        history: document.getElementById("history-list"),
      },
      {
        onOpen: (id) => Net.send("open_game", { gameId: id }),
        onDelete: (id) => {
          if (confirm("Delete this game for everyone?")) {
            Net.send("delete_game", { gameId: id });
          }
        },
      },
    );

    document
      .getElementById("new-game")
      .addEventListener("click", () =>
        Net.send("create_game", { gameType: "wordle" }),
      );

    document.getElementById("edit-name").addEventListener("click", () => {
      const next = prompt("Your name:", storedName());
      if (next == null) return;
      const name = setName(next);
      document.getElementById("you-name").textContent = name;
      Net.send("set_name", { name });
    });
  }

  // ---- wordle game ----
  function wireGame() {
    Wordle.init({
      board: document.getElementById("board"),
      feed: document.getElementById("wordle-feed"),
      players: document.getElementById("wordle-players"),
      status: document.getElementById("wordle-status"),
      delete: document.getElementById("wordle-delete"),
    });
    Keyboard.render(document.getElementById("keyboard"), (key) =>
      Wordle.input(key),
    );

    document.getElementById("wordle-game").addEventListener("click", (e) => {
      if (e.target.closest('[data-nav="leave"]')) {
        Net.send("leave_game");
        Wordle.reset();
        show("lobby");
      } else if (e.target.closest('[data-nav="delete"]')) {
        if (confirm("Delete this game for everyone?")) {
          Net.send("delete_game", { gameId: Wordle.currentGame() });
        }
      }
    });
  }

  // ---- websocket message handlers ----
  function wireNet() {
    Net.setStatusCb((s) => {
      const el = document.getElementById("lobby-status");
      if (el) el.textContent = s === "connected" ? "" : s;
    });

    Net.on("welcome", (m) => {
      Lobby.setMyId(m.id);
      Wordle.setMyId(m.id);
    });

    Net.on("lobby", (m) => {
      Lobby.renderPlayers(m.players);
      Lobby.renderGames(m.games);
    });

    Net.on("game", (m) => {
      const snap = m.snapshot;
      // Entering a game (or already in it): make sure the game view is showing.
      if (Wordle.currentGame() !== snap.id) Wordle.open(snap.id);
      if (!views["wordle-game"].classList.contains("is-active"))
        show("wordle-game");
      Wordle.applySnapshot(snap);
      if (snap.status !== "playing") refreshHistory();
    });

    Net.on("feed", (m) => Wordle.onFeed(m.event));
    Net.on("rejected", () => Wordle.onRejected());
    Net.on("left", () => {
      Wordle.reset();
      show("lobby");
    });
    // The owner deleted a game we were in — bounce back to the lobby.
    Net.on("game_closed", () => {
      Wordle.reset();
      show("lobby");
    });
  }

  // ---- physical keyboard ----
  function wireKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (!views["wordle-game"].classList.contains("is-active")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        Wordle.input("enter");
      } else if (e.key === "Backspace") {
        e.preventDefault();
        Wordle.input("back");
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        Wordle.input(e.key.toLowerCase());
      }
    });
  }

  // ---- boot ----
  wireNameEntry();
  wireLobby();
  wireGame();
  wireNet();
  wireKeyboard();

  const existing = storedName();
  if (existing) {
    document.getElementById("name-input").value = existing;
    enterLobby(existing);
  } else {
    show("name-entry");
    document.getElementById("name-input").focus();
  }
})();
