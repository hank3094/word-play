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

  // ---- per-game-type dispatch (so the rest of app.js doesn't hardcode "Wordle") ----
  const GAME_VIEWS = {
    wordle: { viewId: "wordle-game", controller: Wordle },
    hangman: { viewId: "hangman-game", controller: Hangman },
  };
  let activeGameType = null; // which entry of GAME_VIEWS is currently open, if any
  function activeController() {
    return activeGameType ? GAME_VIEWS[activeGameType].controller : null;
  }

  // ---- per-game static links (/g/<gameId>) ----
  function gameIdFromUrl() {
    const m = location.pathname.match(/^\/g\/([A-Za-z0-9]+)\/?$/);
    return m ? m[1] : null;
  }
  function urlForGame(gid) {
    return `${location.origin}/g/${gid}`;
  }
  // Keep the address bar in sync so the link is always a valid, static URL straight back to
  // whichever game is currently open (or "/" once back in the lobby) — refreshing or sharing it
  // lands on the same place.
  function setGameUrl(gid) {
    history.replaceState(null, "", gid ? `/g/${gid}` : "/");
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
    // A shared /g/<gameId> link: open straight into that game once connected. Net.send queues
    // this until the socket is up (the same disconnected-queue path used for reconnect replays).
    const linkedGid = gameIdFromUrl();
    if (linkedGid) Net.send("open_game", { gameId: linkedGid });
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
        onOpenHistory: (id) => Net.send("open_game", { gameId: id }),
      },
    );

    document
      .getElementById("new-game")
      .addEventListener("click", openNewGameModal);
    wireNewGameModal();

    document
      .getElementById("edit-name")
      .addEventListener("click", openEditProfileModal);
    wireEditProfileModal();
  }

  // ---- edit profile modal ----
  function openEditProfileModal() {
    const modal = document.getElementById("edit-profile-modal");
    const input = document.getElementById("edit-name-input");
    input.value = storedName();
    selectEditSwatch(storedColor());
    modal.hidden = false;
    input.focus();
    input.select();
  }

  function selectEditSwatch(hex) {
    document
      .getElementById("edit-color-swatches")
      .querySelectorAll(".swatch")
      .forEach((b) => {
        b.classList.toggle("selected", b.dataset.color === hex);
        b.setAttribute(
          "aria-pressed",
          b.dataset.color === hex ? "true" : "false",
        );
      });
  }

  function wireEditProfileModal() {
    const modal = document.getElementById("edit-profile-modal");
    const form = document.getElementById("edit-profile-form");
    const swatchRow = document.getElementById("edit-color-swatches");

    PLAYER_COLORS.forEach((hex) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch";
      btn.dataset.color = hex;
      btn.style.setProperty("--c", hex);
      btn.setAttribute("aria-label", hex);
      swatchRow.appendChild(btn);
    });

    swatchRow.addEventListener("click", (e) => {
      const btn = e.target.closest(".swatch");
      if (btn) selectEditSwatch(btn.dataset.color);
    });

    modal.addEventListener("click", (e) => {
      if (e.target.closest('[data-modal="cancel"]') || e.target === modal) {
        modal.hidden = true;
      }
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = setName(document.getElementById("edit-name-input").value);
      const color =
        swatchRow.querySelector(".swatch.selected")?.dataset.color ||
        storedColor();
      pickColor(color);
      document.getElementById("you-name").textContent = name;
      modal.hidden = true;
      Net.send("set_name", { name, color });
    });
  }

  // ---- new game modal ----
  function modalEls() {
    return {
      modal: document.getElementById("new-game-modal"),
      form: document.getElementById("new-game-form"),
      gameTypeOptions: document.getElementById("game-type-options"),
      error: document.getElementById("new-game-error"),
      // wordle
      customRow: document.getElementById("custom-word-row"),
      wordInput: document.getElementById("custom-word"),
      toggle: document.getElementById("toggle-word"),
      hint: document.getElementById("word-length-hint"),
      // hangman
      hangmanDifficultyRow: document.getElementById("hangman-difficulty-row"),
      hangmanCustomRow: document.getElementById("hangman-custom-word-row"),
      hangmanWordInput: document.getElementById("hangman-custom-word"),
      hangmanToggle: document.getElementById("hangman-toggle-word"),
    };
  }

  function selectedWordLength(form) {
    const radio = form.querySelector('input[name="word-length"]:checked');
    return radio ? parseInt(radio.value, 10) : 5;
  }

  function selectedGameType(form) {
    const radio = form.querySelector('input[name="game-type"]:checked');
    return radio ? radio.value : "wordle";
  }

  let gameTypesLoaded = false;
  async function populateGameTypeOptions() {
    if (gameTypesLoaded) return;
    gameTypesLoaded = true;
    const el = modalEls();
    try {
      const { gameTypes } = await API.getGameTypes();
      el.gameTypeOptions.innerHTML = gameTypes
        .map(
          (g, i) =>
            `<label class="radio-row inline">` +
            `<input type="radio" name="game-type" value="${g.key}" ${
              i === 0 ? "checked" : ""
            } /> ${g.label}` +
            `</label>`,
        )
        .join("");
      el.gameTypeOptions
        .querySelectorAll('input[name="game-type"]')
        .forEach((radio) => {
          radio.addEventListener("change", () =>
            showGameTypePanel(selectedGameType(el.form)),
          );
        });
    } catch (_) {
      // Offline at modal-open time: leave the (empty) picker — wordle is still sent by default.
      gameTypesLoaded = false;
    }
  }

  function showGameTypePanel(gameType) {
    document.querySelectorAll("[data-gametype-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.gametypePanel !== gameType;
    });
  }

  function openNewGameModal() {
    const el = modalEls();
    populateGameTypeOptions();
    el.form.reset();
    showGameTypePanel(selectedGameType(el.form));
    el.error.hidden = true;
    // wordle panel defaults
    el.customRow.hidden = true;
    el.wordInput.value = "";
    el.wordInput.maxLength = 5; // reset alongside the word-length radio (which resets to 5)
    el.wordInput.type = "password"; // masked by default
    el.toggle.setAttribute("aria-pressed", "false");
    if (el.hint)
      el.hint.textContent = "5 letters — your friends will try to guess it.";
    // hangman panel defaults
    el.hangmanDifficultyRow.hidden = false;
    el.hangmanCustomRow.hidden = true;
    el.hangmanWordInput.value = "";
    el.hangmanWordInput.type = "password";
    el.hangmanToggle.setAttribute("aria-pressed", "false");
    el.modal.hidden = false;
  }

  function closeNewGameModal() {
    const el = modalEls();
    el.wordInput.value = ""; // don't leave the secret word lying around
    el.hangmanWordInput.value = "";
    el.modal.hidden = true;
  }

  function showModalError(msg) {
    const el = modalEls();
    el.error.textContent = msg;
    el.error.hidden = false;
  }

  function wireNewGameModal() {
    const el = modalEls();

    // ---- wordle fields ----
    // Show/hide the custom-word row with the word-mode radio choice.
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

    // Update maxlength and hint text when word length changes.
    el.form.querySelectorAll('input[name="word-length"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const len = parseInt(radio.value, 10);
        el.wordInput.maxLength = len;
        if (el.hint)
          el.hint.textContent = `${len} letters — your friends will try to guess it.`;
        el.error.hidden = true;
      });
    });

    // Password-style reveal toggle (masked by default).
    el.toggle.addEventListener("click", () => {
      const showing = el.wordInput.type === "text";
      el.wordInput.type = showing ? "password" : "text";
      el.toggle.setAttribute("aria-pressed", String(!showing));
      el.wordInput.focus();
    });

    // ---- hangman fields ----
    // Difficulty only matters for a random word; hide it once the creator picks their own.
    el.form
      .querySelectorAll('input[name="hangman-word-mode"]')
      .forEach((radio) => {
        radio.addEventListener("change", () => {
          const custom =
            el.form.querySelector('input[name="hangman-word-mode"]:checked')
              .value === "custom";
          el.hangmanCustomRow.hidden = !custom;
          el.hangmanDifficultyRow.hidden = custom;
          el.error.hidden = true;
          if (custom) el.hangmanWordInput.focus();
        });
      });

    el.hangmanToggle.addEventListener("click", () => {
      const showing = el.hangmanWordInput.type === "text";
      el.hangmanWordInput.type = showing ? "password" : "text";
      el.hangmanToggle.setAttribute("aria-pressed", String(!showing));
      el.hangmanWordInput.focus();
    });

    el.modal.addEventListener("click", (e) => {
      // Cancel button, or a click on the dimmed backdrop.
      if (e.target.closest('[data-modal="cancel"]') || e.target === el.modal) {
        closeNewGameModal();
      }
    });

    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const gameType = selectedGameType(el.form);

      if (gameType === "hangman") {
        const custom =
          el.form.querySelector('input[name="hangman-word-mode"]:checked')
            .value === "custom";
        if (!custom) {
          const difficulty =
            el.form.querySelector('input[name="hangman-difficulty"]:checked')
              ?.value || "medium";
          Net.send("create_game", {
            gameType: "hangman",
            options: { difficulty },
          });
          return;
        }
        const word = el.hangmanWordInput.value.trim().toLowerCase();
        if (!/^[a-z]{2,24}$/.test(word)) {
          showModalError("The word must be 2-24 letters.");
          return;
        }
        el.error.hidden = true;
        Net.send("create_game", { gameType: "hangman", options: { word } });
        return;
      }

      const len = selectedWordLength(el.form);
      const custom =
        el.form.querySelector('input[name="word-mode"]:checked').value ===
        "custom";
      if (!custom) {
        Net.send("create_game", {
          gameType: "wordle",
          options: { wordLength: len },
        });
        return;
      }
      const word = el.wordInput.value.trim().toLowerCase();
      if (!new RegExp(`^[a-z]{${len}}$`).test(word)) {
        showModalError(`The word must be ${len} letters.`);
        return;
      }
      el.error.hidden = true;
      Net.send("create_game", {
        gameType: "wordle",
        options: { wordLength: len, word },
      });
      // The modal closes when we enter the game (the `game` message) or shows a server error.
    });
  }

  // ---- game settings modal ----
  function wireGameSettingsModal() {
    const modal = document.getElementById("game-settings-modal");
    document
      .getElementById("game-settings-btn")
      .addEventListener("click", () => {
        modal.hidden = false;
      });
    modal.addEventListener("click", (e) => {
      if (e.target.closest('[data-modal="cancel"]') || e.target === modal) {
        modal.hidden = true;
      }
    });
  }

  // ---- copy-link button ----
  function wireGameLinkButton(btnId) {
    const btn = document.getElementById(btnId);
    btn.addEventListener("click", async () => {
      const gid = activeController() && activeController().currentGame();
      if (!gid) return;
      const url = urlForGame(gid);
      try {
        await navigator.clipboard.writeText(url);
      } catch (_) {
        // Clipboard API unavailable (e.g. insecure context) — fall back to a selectable prompt.
        window.prompt("Copy this link:", url);
        return;
      }
      const original = btn.textContent;
      btn.textContent = "✓";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1200);
    });
  }

  // ---- wordle game ----
  function wireGame() {
    const keyboard = Keyboard.create(
      document.getElementById("keyboard"),
      (key) => Wordle.input(key),
    );
    Wordle.init({
      board: document.getElementById("board"),
      feed: document.getElementById("wordle-feed"),
      players: document.getElementById("wordle-players"),
      status: document.getElementById("wordle-status"),
      delete: document.getElementById("wordle-delete"),
      shareToggleBtn: document.getElementById("share-toggle-btn"),
      settingsBtn: document.getElementById("game-settings-btn"),
      settingsAllowSharing: document.getElementById("settings-allow-sharing"),
      keyboard,
    });
    wireGameSettingsModal();
    wireGameLinkButton("game-link-btn");

    document.getElementById("wordle-game").addEventListener("click", (e) => {
      if (e.target.closest('[data-nav="leave"]')) {
        leaveCurrentGame();
      } else if (e.target.closest('[data-nav="delete"]')) {
        if (confirm("Delete this game for everyone?")) {
          Net.send("delete_game", { gameId: Wordle.currentGame() });
        }
      }
    });
  }

  // ---- hangman game ----
  function wireHangmanGame() {
    const keyboard = Keyboard.create(
      document.getElementById("hangman-keyboard"),
      (letter) => Hangman.input(letter),
      { lettersOnly: true },
    );
    Hangman.init({
      figure: document.querySelector("#hangman-game .hangman-figure"),
      word: document.getElementById("hangman-word"),
      feed: document.getElementById("hangman-feed"),
      players: document.getElementById("hangman-players"),
      status: document.getElementById("hangman-status"),
      delete: document.getElementById("hangman-delete"),
      revealRow: document.getElementById("hangman-reveal-row"),
      revealBtn: document.getElementById("hangman-reveal-btn"),
      keyboard,
    });
    wireGameLinkButton("hangman-link-btn");

    document.getElementById("hangman-game").addEventListener("click", (e) => {
      if (e.target.closest('[data-nav="leave"]')) {
        leaveCurrentGame();
      } else if (e.target.closest('[data-nav="delete"]')) {
        if (confirm("Delete this game for everyone?")) {
          Net.send("delete_game", { gameId: Hangman.currentGame() });
        }
      }
    });
  }

  // Shared by every game view's "← LOBBY" button.
  function leaveCurrentGame() {
    Net.send("leave_game");
    if (activeController()) activeController().reset();
    activeGameType = null;
    Activity.setCurrentGame(null);
    setGameUrl(null);
    show("lobby");
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
        close: document.getElementById("activity-close"),
        resizer: document.getElementById("panel-resizer"),
      },
      {
        onOpenGame: (gid) => Net.send("open_game", { gameId: gid }),
        onFetchActivity: (offset) => Net.send("fetch_activity", { offset }),
      },
    );
  }

  // ---- websocket message handlers ----
  function wireNet() {
    Net.setStatusCb((s) => {
      const el = document.getElementById("lobby-status");
      if (el) el.textContent = s === "connected" ? "" : s;
    });

    // Spinner shown only while an action fired during a disconnect waits to execute.
    const overlay = document.getElementById("reconnect-overlay");
    Net.setPendingCb((active) => {
      if (overlay) overlay.hidden = !active;
    });

    Net.on("welcome", (m) => {
      Lobby.setMyId(m.id);
      Wordle.setMyId(m.id);
      Hangman.setMyId(m.id);
      // If the socket dropped while we were in a game, rejoin it after reconnecting so the server
      // re-associates us (a fresh connection starts with no current game).
      const gv = activeGameType && GAME_VIEWS[activeGameType];
      const gid = gv && gv.controller.currentGame();
      if (gid && views[gv.viewId].classList.contains("is-active")) {
        Net.send("open_game", { gameId: gid });
      }
    });

    Net.on("lobby", (m) => {
      Lobby.renderPlayers(m.players);
      Lobby.renderGames(m.games);
    });

    Net.on("game", (m) => {
      const snap = m.snapshot;
      const gv = GAME_VIEWS[snap.gameType];
      if (!gv) return; // unknown game type — defensive no-op
      closeNewGameModal(); // we successfully created/entered a game
      activeGameType = snap.gameType;
      // Entering a game (or already in it): make sure the game view is showing.
      if (gv.controller.currentGame() !== snap.id) gv.controller.open(snap.id);
      if (!views[gv.viewId].classList.contains("is-active")) show(gv.viewId);
      gv.controller.applySnapshot(snap);
      Activity.setCurrentGame(snap.id);
      setGameUrl(snap.id);
      if (snap.status !== "playing") refreshHistory();
    });

    // A custom word the server wouldn't accept (e.g. not in the word list).
    Net.on("create_error", (m) => showModalError(m.error));

    Net.on("activity_log", (m) =>
      Activity.load(m.events, m.offset || 0, !!m.hasMore),
    );
    Net.on("activity_event", (m) => Activity.push(m.event));
    Net.on(
      "feed",
      (m) => activeController() && activeController().onFeed(m.event),
    );
    Net.on(
      "rejected",
      (m) => activeController() && activeController().onRejected(m.reason),
    );
    Net.on("left", () => {
      if (activeController()) activeController().reset();
      activeGameType = null;
      Activity.setCurrentGame(null);
      setGameUrl(null);
      show("lobby");
    });
    // The owner deleted a game we were in — bounce back to the lobby.
    Net.on("game_closed", () => {
      if (activeController()) activeController().reset();
      activeGameType = null;
      Activity.setCurrentGame(null);
      setGameUrl(null);
      show("lobby");
    });
  }

  // ---- physical keyboard ----
  function wireKeyboard() {
    window.addEventListener("keydown", (e) => {
      const gv = activeGameType && GAME_VIEWS[activeGameType];
      if (!gv || !views[gv.viewId].classList.contains("is-active")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (activeGameType === "wordle") {
        if (e.key === "Enter") {
          e.preventDefault();
          gv.controller.input("enter");
        } else if (e.key === "Backspace") {
          e.preventDefault();
          gv.controller.input("back");
        } else if (/^[a-zA-Z]$/.test(e.key)) {
          e.preventDefault();
          gv.controller.input(e.key.toLowerCase());
        }
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        // Other game types (e.g. hangman) only take single-letter input — no enter/backspace.
        e.preventDefault();
        gv.controller.input(e.key.toLowerCase());
      }
    });
  }

  // ---- boot ----
  wireNameEntry();
  wireLobby();
  wireGame();
  wireHangmanGame();
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
