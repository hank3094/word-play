// Top-level app: name entry, view routing, WebSocket wiring, and input dispatch. Loads last so all
// the module globals (API, Net, Keyboard, Board, Wordle, Lobby) are defined.
(() => {
  const views = {};
  document.querySelectorAll(".view").forEach((v) => (views[v.id] = v));

  const NAME_KEY = "wp-name";
  const COLOR_KEY = "wp-color";
  const PLAYER_COLORS = [
    "#4d7c5a", // green
    "#4a6fa5", // blue
    "#a06030", // amber
    "#7040a0", // purple
    "#a04040", // red
    "#30908a", // teal
  ];

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

  function storedColor() {
    const c = localStorage.getItem(COLOR_KEY) || "";
    return PLAYER_COLORS.includes(c) ? c : PLAYER_COLORS[0];
  }
  function pickColor(hex) {
    localStorage.setItem(COLOR_KEY, hex);
    return hex;
  }

  // ---- name entry ----
  function wireNameEntry() {
    const form = document.getElementById("name-form");
    const input = document.getElementById("name-input");
    input.value = storedName();

    // Build colour swatches from the palette.
    const swatchRow = document.getElementById("color-swatches");
    if (swatchRow) {
      PLAYER_COLORS.forEach((hex) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "swatch";
        btn.dataset.color = hex;
        btn.style.setProperty("--c", hex);
        btn.setAttribute("aria-label", hex);
        swatchRow.appendChild(btn);
      });
      function selectSwatch(hex) {
        swatchRow.querySelectorAll(".swatch").forEach((b) => {
          b.classList.toggle("selected", b.dataset.color === hex);
          b.setAttribute(
            "aria-pressed",
            b.dataset.color === hex ? "true" : "false",
          );
        });
        pickColor(hex);
      }
      selectSwatch(storedColor());
      swatchRow.addEventListener("click", (e) => {
        const btn = e.target.closest(".swatch");
        if (btn) selectSwatch(btn.dataset.color);
      });
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = setName(input.value);
      enterLobby(name);
    });
  }

  // ---- lobby ----
  function enterLobby(name) {
    document.getElementById("you-name").textContent = name;
    Net.connect(name, storedColor());
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
      .addEventListener("click", openNewGameModal);
    wireNewGameModal();

    document.getElementById("edit-name").addEventListener("click", () => {
      const next = prompt("Your name:", storedName());
      if (next == null) return;
      const name = setName(next);
      document.getElementById("you-name").textContent = name;
      Net.send("set_name", { name });
    });
  }

  // ---- new game modal ----
  function modalEls() {
    return {
      modal: document.getElementById("new-game-modal"),
      form: document.getElementById("new-game-form"),
      customRow: document.getElementById("custom-word-row"),
      wordInput: document.getElementById("custom-word"),
      toggle: document.getElementById("toggle-word"),
      error: document.getElementById("new-game-error"),
    };
  }

  function openNewGameModal() {
    const el = modalEls();
    el.form.reset();
    el.customRow.hidden = true;
    el.wordInput.value = "";
    el.wordInput.type = "password"; // masked by default
    el.toggle.setAttribute("aria-pressed", "false");
    el.error.hidden = true;
    el.modal.hidden = false;
  }

  function closeNewGameModal() {
    const el = modalEls();
    el.wordInput.value = ""; // don't leave the secret word lying around
    el.modal.hidden = true;
  }

  function showModalError(msg) {
    const el = modalEls();
    el.error.textContent = msg;
    el.error.hidden = false;
  }

  function wireNewGameModal() {
    const el = modalEls();

    // Show/hide the custom-word row with the radio choice.
    el.form.querySelectorAll('input[name="word-mode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const custom =
          el.form.querySelector('input[name="word-mode"]:checked').value ===
          "custom";
        el.customRow.hidden = !custom;
        el.error.hidden = true;
        if (custom) el.wordInput.focus();
      });
    });

    // Password-style reveal toggle (masked by default).
    el.toggle.addEventListener("click", () => {
      const showing = el.wordInput.type === "text";
      el.wordInput.type = showing ? "password" : "text";
      el.toggle.setAttribute("aria-pressed", String(!showing));
      el.wordInput.focus();
    });

    el.modal.addEventListener("click", (e) => {
      // Cancel button, or a click on the dimmed backdrop.
      if (e.target.closest('[data-modal="cancel"]') || e.target === el.modal) {
        closeNewGameModal();
      }
    });

    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const custom =
        el.form.querySelector('input[name="word-mode"]:checked').value ===
        "custom";
      if (!custom) {
        Net.send("create_game", { gameType: "wordle" });
        return;
      }
      const word = el.wordInput.value.trim().toLowerCase();
      if (!/^[a-z]{5}$/.test(word)) {
        showModalError("The word must be 5 letters.");
        return;
      }
      el.error.hidden = true;
      Net.send("create_game", { gameType: "wordle", options: { word } });
      // The modal closes when we enter the game (the `game` message) or shows a server error.
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
        Activity.setCurrentGame(null);
        show("lobby");
      } else if (e.target.closest('[data-nav="delete"]')) {
        if (confirm("Delete this game for everyone?")) {
          Net.send("delete_game", { gameId: Wordle.currentGame() });
        }
      }
    });
  }

  // ---- activity panel ----
  function wireActivity() {
    Activity.init(
      {
        panel: document.getElementById("activity-panel"),
        list: document.getElementById("activity-list"),
        filter: document.getElementById("show-rejected"),
        gameFilter: document.getElementById("this-game-only"),
        gameFilterRow: document.getElementById("game-filter-row"),
        toggle: document.getElementById("activity-toggle"),
        close: document.getElementById("activity-close"),
      },
      {
        onOpenGame: (gid) => Net.send("open_game", { gameId: gid }),
      },
    );
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
      // If the socket dropped while we were in a game, rejoin it after reconnecting so the server
      // re-associates us (a fresh connection starts with no current game).
      const gid = Wordle.currentGame();
      if (gid && views["wordle-game"].classList.contains("is-active")) {
        Net.send("open_game", { gameId: gid });
      }
    });

    Net.on("lobby", (m) => {
      Lobby.renderPlayers(m.players);
      Lobby.renderGames(m.games);
    });

    Net.on("game", (m) => {
      const snap = m.snapshot;
      closeNewGameModal(); // we successfully created/entered a game
      // Entering a game (or already in it): make sure the game view is showing.
      if (Wordle.currentGame() !== snap.id) Wordle.open(snap.id);
      if (!views["wordle-game"].classList.contains("is-active"))
        show("wordle-game");
      Wordle.applySnapshot(snap);
      Activity.setCurrentGame(snap.id);
      if (snap.status !== "playing") refreshHistory();
    });

    // A custom word the server wouldn't accept (e.g. not in the word list).
    Net.on("create_error", (m) => showModalError(m.error));

    Net.on("activity_log", (m) => Activity.load(m.events));
    Net.on("activity_event", (m) => Activity.push(m.event));
    Net.on("feed", (m) => Wordle.onFeed(m.event));
    Net.on("rejected", (m) => Wordle.onRejected(m.reason));
    Net.on("left", () => {
      Wordle.reset();
      Activity.setCurrentGame(null);
      show("lobby");
    });
    // The owner deleted a game we were in — bounce back to the lobby.
    Net.on("game_closed", () => {
      Wordle.reset();
      Activity.setCurrentGame(null);
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
  wireActivity();
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
