/**
 * OpenCode Bridge - webview frontend.
 *
 * Extension <-> webview traffic goes through `acquireVsCodeApi()`.
 * The renderer is strict-CSP friendly: no inline styles, no inline event
 * handlers. All dynamic HTML is escaped by `OcMarkdown` / `textContent`.
 */
(function () {
  "use strict";

  var vscodeApi = acquireVsCodeApi();
  var Markdown = window.OcMarkdown;

  var headerEl = document.getElementById("header");
  var messagesEl = document.getElementById("messages");
  var emptyStateEl = document.getElementById("emptyState");
  var inputEl = document.getElementById("input");
  var composer = document.getElementById("composer");
  var btnSend = document.getElementById("btnSend");
  var btnStop = document.getElementById("btnStop");
  var btnNewChat = document.getElementById("btnNewChat");
  var btnRefresh = document.getElementById("btnRefresh");
  var btnKey = document.getElementById("btnKey");
  var btnCancelWait = document.getElementById("btnCancelWait");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("statusText");
  var jumpLatest = document.getElementById("jumpLatest");

  var modelButton = document.getElementById("modelButton");
  var modelLabel = document.getElementById("modelLabel");
  var modelPopover = document.getElementById("modelPopover");
  var modelSearch = document.getElementById("modelSearch");
  var modelList = document.getElementById("modelList");
  var welcomeModel = document.getElementById("welcomeModel");

  var agentButton = document.getElementById("agentButton");
  var agentLabel = document.getElementById("agentLabel");
  var agentPopover = document.getElementById("agentPopover");
  var agentList = document.getElementById("agentList");
  var sessionButton = document.getElementById("sessionButton");
  var sessionLabel = document.getElementById("sessionLabel");
  var sessionPanel = document.getElementById("sessionPanel");
  var sessionSearch = document.getElementById("sessionSearch");
  var sessionList = document.getElementById("sessionList");
  var sessionMore = document.getElementById("sessionMore");
  var sessionNew = document.getElementById("sessionNew");
  var variantButton = document.getElementById("variantButton");
  var variantLabel = document.getElementById("variantLabel");
  var variantPopover = document.getElementById("variantPopover");
  var variantList = document.getElementById("variantList");

  var contextBar = document.getElementById("contextBar");
  var contextProgress = document.getElementById("contextProgress");
  var contextText = document.getElementById("contextText");
  var btnCompact = document.getElementById("btnCompact");
  var compactionEl = document.getElementById("compaction");
  var compactionText = document.getElementById("compactionText");
  var slashPalette = document.getElementById("slashPalette");

  var bannerEl = document.getElementById("banner");
  var bannerIcon = document.getElementById("bannerIcon");
  var bannerMessage = document.getElementById("bannerMessage");
  var bannerDetails = document.getElementById("bannerDetails");
  var bannerDetailsWrap = document.getElementById("bannerDetailsWrap");
  var bannerActions = document.getElementById("bannerActions");
  var bannerDismiss = document.getElementById("bannerDismiss");

  if (
    !Markdown ||
    !headerEl ||
    !messagesEl ||
    !inputEl ||
    !composer ||
    !btnSend ||
    !modelButton ||
    !modelPopover ||
    !modelList
  ) {
    // Do not throw silently: surface a message the user can see.
    if (messagesEl) messagesEl.textContent = "OpenCode Bridge failed to load (missing DOM elements).";
    return;
  }

  var state = {
    sessionID: null,
    models: [],
    selectedModel: null,
    agents: [],
    agent: null,
    commands: [],
    skills: [],
    sessions: [],
    sessionsCursor: null,
    mode: "managed",
    serverUrl: "",
    workspaceDir: "",
    generating: false,
    context: { used: 0, limit: 0, percent: 0, cost: 0, breakdown: null },
    compaction: null,
    permissions: new Map(),
    forms: new Map(),
    slashIndex: 0,
    slashItems: [],
    sessionSearchValue: "",
  };

  var stream = {
    el: null,
    body: null,
    id: null,
    text: "",
    reasoning: null,
    tools: new Map(),
    answers: null,
    thinking: null,
    toolList: null,
    files: new Map(),
    meta: null,
  };
  var codeSeq = 0;
  var codeStore = new Map();

  function resetStream() {
    stream = {
      el: null,
      body: null,
      id: null,
      text: "",
      reasoning: null,
      tools: new Map(),
      answers: null,
      thinking: null,
      toolList: null,
      files: new Map(),
      meta: null,
    };
  }
  resetStream();

  function makeEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function formatDuration(ms) {
    var seconds = Math.max(0, Math.round((ms || 0) / 1000));
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    return minutes + "m " + (seconds % 60) + "s";
  }

  function formatRelative(ts) {
    if (!ts) return "";
    var delta = Date.now() - ts;
    if (delta < 60000) return "just now";
    if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
    if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
    return Math.floor(delta / 86400000) + "d ago";
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n || 0);
  }

  function post(message) {
    vscodeApi.postMessage(message);
  }

  function escapeHtml(value) {
    return Markdown.escapeHtml(value);
  }

  /* ------------------------------------------------------------------ */
  /* Code blocks + Markdown                                             */
  /* ------------------------------------------------------------------ */

  function renderCodeBlock(lang, code) {
    codeSeq += 1;
    var id = "cb" + codeSeq;
    codeStore.set(id, code);
    if (codeStore.size > 600) {
      var oldest = codeStore.keys().next().value;
      if (oldest) codeStore.delete(oldest);
    }
    return (
      '<div class="code-block">' +
      '<div class="code-header">' +
      '<span class="code-lang">' +
      escapeHtml(lang || "text") +
      "</span>" +
      '<span class="code-actions">' +
      '<button type="button" class="code-btn" data-wrap="' +
      id +
      '" aria-label="Toggle line wrapping">Wrap</button>' +
      '<button type="button" class="code-btn" data-copy="' +
      id +
      '" aria-label="Copy code">Copy</button>' +
      "</span>" +
      "</div>" +
      '<pre class="code-pre"><code data-code="' +
      id +
      '">' +
      escapeHtml(code) +
      "</code></pre>" +
      "</div>"
    );
  }

  function renderMarkdown(text) {
    return Markdown.renderMarkdown(text, { renderCodeBlock: renderCodeBlock });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "clipboard-fallback";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_err) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* Header / model picker                                              */
  /* ------------------------------------------------------------------ */

  function sameModel(a, b) {
    return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
  }

  function selectedModelEntry() {
    if (!state.selectedModel) return null;
    for (var i = 0; i < state.models.length; i += 1) {
      if (sameModel(state.models[i], state.selectedModel)) return state.models[i];
    }
    return null;
  }

  function selectedModelText() {
    var entry = selectedModelEntry();
    if (entry) return entry.label + " · " + entry.providerID;
    if (state.selectedModel) return state.selectedModel.providerID + "/" + state.selectedModel.modelID;
    return "Default model";
  }

  function updateModelLabel() {
    modelLabel.textContent = selectedModelText();
    if (welcomeModel) welcomeModel.textContent = selectedModelText();
  }

  function updateHeaderInfo(info) {
    if (!info) return;
    if (typeof info.serverUrl === "string") state.serverUrl = info.serverUrl;
    if (typeof info.workspaceDir === "string") state.workspaceDir = info.workspaceDir;
    if (typeof info.mode === "string") state.mode = info.mode;

    var lines = [];
    if (state.mode) lines.push("Mode: " + state.mode);
    if (state.serverUrl) lines.push("Server: " + state.serverUrl);
    if (state.workspaceDir) lines.push("Workspace: " + state.workspaceDir);
    headerEl.title = lines.join("\n");
  }

  function makeModelItem(entry) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "model-item";
    button.setAttribute("role", "option");
    button.dataset.provider = entry ? entry.providerID : "";
    button.dataset.model = entry ? entry.modelID : "";
    button.setAttribute(
      "aria-selected",
      entry ? String(sameModel(entry, state.selectedModel)) : String(!state.selectedModel)
    );

    var name = document.createElement("span");
    name.className = "model-item-name";
    name.textContent = entry ? entry.label : "Default model (server default)";
    button.appendChild(name);

    if (entry && entry.providerID) {
      var provider = document.createElement("span");
      provider.className = "model-item-provider";
      provider.textContent = entry.providerID;
      button.appendChild(provider);
    }
    return button;
  }

  function renderModelList() {
    var term = (modelSearch.value || "").trim().toLowerCase();
    var filtered = state.models.filter(function (model) {
      if (!term) return true;
      var haystack = (model.label + " " + model.providerID + " " + model.modelID).toLowerCase();
      return haystack.indexOf(term) !== -1;
    });

    modelList.innerHTML = "";
    modelList.appendChild(makeModelItem(null));

    if (filtered.length === 0) {
      var empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = state.models.length === 0 ? "No models loaded yet" : "No matching models";
      modelList.appendChild(empty);
      return;
    }

    var groups = new Map();
    filtered.forEach(function (model) {
      var provider = model.providerID || "other";
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(model);
    });

    groups.forEach(function (models, provider) {
      var heading = document.createElement("div");
      heading.className = "model-group";
      heading.textContent = provider;
      modelList.appendChild(heading);
      models.forEach(function (model) {
        modelList.appendChild(makeModelItem(model));
      });
    });
  }

  function openPopover() {
    modelPopover.hidden = false;
    modelButton.setAttribute("aria-expanded", "true");
    renderModelList();
    modelSearch.value = "";
    modelSearch.focus();
  }

  function closePopover() {
    modelPopover.hidden = true;
    modelButton.setAttribute("aria-expanded", "false");
  }

  modelButton.addEventListener("click", function () {
    if (modelPopover.hidden) openPopover();
    else closePopover();
  });

  modelSearch.addEventListener("input", renderModelList);

  modelPopover.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
      modelButton.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      var items = Array.prototype.slice.call(modelList.querySelectorAll(".model-item"));
      if (items.length === 0) return;
      event.preventDefault();
      var index = items.indexOf(document.activeElement);
      var next;
      if (event.key === "ArrowDown") next = items[Math.min(items.length - 1, index + 1)];
      else next = items[Math.max(0, index - 1)];
      (next || items[0]).focus();
    }
  });

  modelList.addEventListener("click", function (event) {
    var item = event.target.closest(".model-item");
    if (!item) return;
    var provider = item.dataset.provider || "";
    var modelID = item.dataset.model || "";
    if (!provider || !modelID) {
      state.selectedModel = null;
      post({ type: "selectModel", model: null });
    } else {
      state.selectedModel = { providerID: provider, modelID: modelID };
      post({ type: "selectModel", model: state.selectedModel });
    }
    updateModelLabel();
    closePopover();
  });

  document.addEventListener("click", function (event) {
    if (modelPopover.hidden) return;
    if (modelPopover.contains(event.target) || modelButton.contains(event.target)) return;
    closePopover();
  });

  /* ------------------------------------------------------------------ */
  /* Agents                                                             */
  /* ------------------------------------------------------------------ */

  function agentEntry(id) {
    for (var i = 0; i < state.agents.length; i += 1) {
      if (state.agents[i].id === id) return state.agents[i];
    }
    return null;
  }

  function updateAgentLabel() {
    var entry = agentEntry(state.agent);
    agentLabel.textContent = entry ? entry.name : state.agent || "Agent";
    if (entry && entry.description) agentButton.title = entry.description;
  }

  function renderAgentList() {
    agentList.innerHTML = "";
    if (state.agents.length === 0) {
      agentList.appendChild(makeEl("div", "model-empty", "No agents loaded"));
      return;
    }
    state.agents.forEach(function (agent) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "model-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(agent.id === state.agent));
      button.dataset.agent = agent.id;
      button.appendChild(makeEl("span", "model-item-name", agent.name || agent.id));
      if (agent.description) {
        var desc = makeEl("span", "agent-desc", agent.description);
        desc.dir = "auto";
        button.appendChild(desc);
      }
      agentList.appendChild(button);
    });
  }

  function openAgents() {
    renderAgentList();
    agentPopover.hidden = false;
    agentButton.setAttribute("aria-expanded", "true");
    var first = agentList.querySelector(".model-item");
    if (first) first.focus();
  }

  function closeAgents() {
    agentPopover.hidden = true;
    agentButton.setAttribute("aria-expanded", "false");
  }

  agentButton.addEventListener("click", function () {
    if (agentPopover.hidden) openAgents();
    else closeAgents();
  });

  agentList.addEventListener("click", function (event) {
    var item = event.target.closest("[data-agent]");
    if (!item) return;
    state.agent = item.dataset.agent;
    updateAgentLabel();
    post({ type: "selectAgent", agent: state.agent });
    closeAgents();
  });

  /* ------------------------------------------------------------------ */
  /* Sessions                                                           */
  /* ------------------------------------------------------------------ */

  function updateSessionLabel() {
    var current = null;
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].id === state.sessionID) current = state.sessions[i];
    }
    sessionLabel.textContent = current ? current.title || "Sessions" : "Sessions";
  }

  function renderSessions() {
    sessionList.innerHTML = "";
    var sessions = state.sessions || [];
    if (sessions.length === 0) {
      sessionList.appendChild(makeEl("div", "model-empty", "No sessions found"));
      return;
    }
    sessions.forEach(function (session) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "session-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(session.id === state.sessionID));
      button.dataset.session = session.id;
      var top = makeEl("span", "session-title", session.title || "Untitled");
      top.dir = "auto";
      button.appendChild(top);
      var meta = makeEl("span", "session-meta");
      meta.appendChild(makeEl("span", "", formatRelative(session.updated)));
      if (session.directory) {
        var dir = makeEl("span", "session-dir", session.directory);
        dir.dir = "auto";
        meta.appendChild(dir);
      }
      if (session.busy) meta.appendChild(makeEl("span", "session-busy", "running"));
      button.appendChild(meta);
      sessionList.appendChild(button);
    });
    sessionMore.hidden = !state.sessionsCursor;
  }

  function openSessions() {
    renderSessions();
    sessionPanel.hidden = false;
    sessionButton.setAttribute("aria-expanded", "true");
    sessionSearch.value = state.sessionSearchValue || "";
    sessionSearch.focus();
    post({ type: "listSessions", search: state.sessionSearchValue || undefined });
  }

  function closeSessions() {
    sessionPanel.hidden = true;
    sessionButton.setAttribute("aria-expanded", "false");
  }

  sessionButton.addEventListener("click", function () {
    if (sessionPanel.hidden) openSessions();
    else closeSessions();
  });

  sessionList.addEventListener("click", function (event) {
    var item = event.target.closest("[data-session]");
    if (!item) return;
    var id = item.dataset.session;
    closeSessions();
    post({ type: "switchSession", sessionID: id });
  });

  var sessionSearchTimer = null;
  sessionSearch.addEventListener("input", function () {
    state.sessionSearchValue = sessionSearch.value;
    window.clearTimeout(sessionSearchTimer);
    sessionSearchTimer = window.setTimeout(function () {
      post({ type: "listSessions", search: state.sessionSearchValue || undefined });
    }, 200);
  });

  sessionMore.addEventListener("click", function () {
    post({
      type: "listSessions",
      search: state.sessionSearchValue || undefined,
      cursor: state.sessionsCursor || undefined,
      append: true,
    });
  });

  sessionNew.addEventListener("click", function () {
    closeSessions();
    post({ type: "newChat" });
  });

  /* ------------------------------------------------------------------ */
  /* Model variants                                                     */
  /* ------------------------------------------------------------------ */

  function currentVariants() {
    var entry = selectedModelEntry();
    return entry && Array.isArray(entry.variants) ? entry.variants : [];
  }

  function updateVariantControl() {
    var variants = currentVariants();
    if (variants.length === 0) {
      variantButton.hidden = true;
      return;
    }
    variantButton.hidden = false;
    variantLabel.textContent =
      (state.selectedModel && state.selectedModel.variant) || "default";
  }

  function renderVariants() {
    variantList.innerHTML = "";
    var variants = currentVariants();
    if (variants.length === 0) {
      variantList.appendChild(makeEl("div", "model-empty", "No variants"));
      return;
    }
    variants.forEach(function (id) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "model-item";
      button.setAttribute("role", "option");
      button.dataset.variant = id;
      var selected = state.selectedModel && state.selectedModel.variant === id;
      button.setAttribute("aria-selected", String(!!selected));
      button.appendChild(makeEl("span", "model-item-name", id));
      variantList.appendChild(button);
    });
  }

  variantButton.addEventListener("click", function () {
    renderVariants();
    variantPopover.hidden = !variantPopover.hidden;
    variantButton.setAttribute("aria-expanded", String(!variantPopover.hidden));
  });

  variantList.addEventListener("click", function (event) {
    var item = event.target.closest("[data-variant]");
    if (!item) return;
    var variant = item.dataset.variant;
    if (!state.selectedModel) return;
    state.selectedModel = {
      providerID: state.selectedModel.providerID,
      modelID: state.selectedModel.modelID,
      variant: variant,
    };
    updateVariantControl();
    variantPopover.hidden = true;
    variantButton.setAttribute("aria-expanded", "false");
    post({
      type: "selectVariant",
      model: {
        providerID: state.selectedModel.providerID,
        modelID: state.selectedModel.modelID,
      },
      variant: variant,
    });
  });

  document.addEventListener("click", function (event) {
    if (!agentPopover.hidden) {
      if (!agentPopover.contains(event.target) && !agentButton.contains(event.target)) closeAgents();
    }
    if (!sessionPanel.hidden) {
      if (!sessionPanel.contains(event.target) && !sessionButton.contains(event.target)) closeSessions();
    }
    if (!variantPopover.hidden) {
      if (!variantPopover.contains(event.target) && !variantButton.contains(event.target)) {
        variantPopover.hidden = true;
        variantButton.setAttribute("aria-expanded", "false");
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Context meter + compaction                                         */
  /* ------------------------------------------------------------------ */

  function renderContext(ctx) {
    state.context = ctx || state.context;
    var used = state.context.used || 0;
    var limit = state.context.limit || 0;
    var percent = state.context.percent || 0;
    contextBar.hidden = false;
    contextProgress.value = Math.max(0, Math.min(100, percent));
    contextBar.classList.remove("warn", "danger");
    if (percent > 90) contextBar.classList.add("danger");
    else if (percent > 70) contextBar.classList.add("warn");
    contextText.textContent =
      formatTokens(used) + " / " + (limit ? formatTokens(limit) : "?") + " (" + percent + "%)";
    var parts = [];
    if (state.context.breakdown) {
      var b = state.context.breakdown;
      parts.push("input " + b.input + ", cache read " + b.cache.read);
      parts.push("output " + b.output + ", reasoning " + b.reasoning);
      parts.push("cache write " + b.cache.write);
    }
    if (state.context.cost) parts.push("cost $" + Number(state.context.cost).toFixed(4));
    if (limit) parts.push("limit " + limit);
    contextBar.title = parts.length
      ? parts.join("\n")
      : "Context usage is estimated from the latest step (input + cache read).";
  }

  function renderCompaction(compaction) {
    state.compaction = compaction || null;
    if (!compaction) {
      compactionEl.hidden = true;
      return;
    }
    compactionEl.hidden = false;
    compactionEl.classList.toggle("done", !compaction.running);
    compactionText.textContent = compaction.running
      ? "Compacting conversation…" + (compaction.text ? " " + formatTokens(compaction.text.length) + " chars" : "")
      : "Compaction " + (compaction.reason || "manual") + " finished.";
  }

  btnCompact.addEventListener("click", function () {
    if (!state.sessionID || state.generating) return;
    post({ type: "compact" });
  });

  /* ------------------------------------------------------------------ */
  /* Slash palette                                                      */
  /* ------------------------------------------------------------------ */

  var BUILTIN_COMMANDS = [
    { name: "new", description: "Start a new chat" },
    { name: "sessions", description: "Switch session" },
    { name: "models", description: "Choose a model" },
    { name: "compact", description: "Compact the conversation" },
    { name: "undo", description: "Undo the last turn" },
    { name: "redo", description: "Redo the last undone turn" },
    { name: "agent", description: "Choose an agent" },
    { name: "clear", description: "Clear the chat view" },
  ];

  function slashCandidates() {
    var items = [];
    BUILTIN_COMMANDS.forEach(function (c) {
      items.push({ kind: "builtin", name: c.name, description: c.description });
    });
    state.commands.forEach(function (c) {
      items.push({ kind: "command", name: c.name, description: c.description || "Custom command" });
    });
    state.skills.forEach(function (s) {
      items.push({ kind: "skill", name: s.name, description: s.description || "Skill" });
    });
    return items;
  }

  var Slash = typeof globalThis !== "undefined" ? globalThis.OcSlash : null;

  function currentSlashQuery() {
    var value = inputEl.value || "";
    if (Slash && typeof Slash.slashQuery === "function") {
      return Slash.slashQuery(value);
    }
    var match = /^\/([a-zA-Z0-9_-]*)$/.exec(value);
    if (!match) return null;
    return match[1].toLowerCase();
  }

  function closeSlash() {
    slashPalette.hidden = true;
    state.slashItems = [];
    state.slashIndex = 0;
  }

  function renderSlash() {
    var query = currentSlashQuery();
    if (query === null) {
      closeSlash();
      return;
    }
    var items = slashCandidates();
    if (Slash && typeof Slash.filterSlashItems === "function") {
      items = Slash.filterSlashItems(items, query);
    } else {
      items = items.filter(function (item) {
        var hay = (item.name + " " + (item.description || "")).toLowerCase();
        return !query || hay.indexOf(query) !== -1;
      });
    }
    state.slashItems = items;
    state.slashIndex = Math.min(state.slashIndex, Math.max(0, items.length - 1));
    slashPalette.innerHTML = "";
    slashPalette.hidden = false;
    if (items.length === 0) {
      slashPalette.appendChild(makeEl("div", "model-empty", "No matching commands"));
      return;
    }
    items.forEach(function (item, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "slash-item" + (index === state.slashIndex ? " active" : "");
      button.dataset.index = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === state.slashIndex));
      button.appendChild(makeEl("span", "slash-name", "/" + item.name));
      button.appendChild(makeEl("span", "slash-kind", item.kind));
      if (item.description) {
        var desc = makeEl("span", "slash-desc", item.description);
        desc.dir = "auto";
        button.appendChild(desc);
      }
      slashPalette.appendChild(button);
    });
  }

  function chooseSlash(index) {
    var item = state.slashItems[index];
    if (!item) return;
    inputEl.value = "";
    resizeTextarea();
    closeSlash();
    if (item.kind === "builtin") {
      if (item.name === "new") post({ type: "newChat" });
      else if (item.name === "sessions") openSessions();
      else if (item.name === "models") openPopover();
      else if (item.name === "compact") post({ type: "compact" });
      else if (item.name === "undo") post({ type: "undo" });
      else if (item.name === "redo") post({ type: "redo" });
      else if (item.name === "agent") openAgents();
      else if (item.name === "clear") {
        messagesEl.innerHTML = "";
        updateEmptyState();
      }
      return;
    }
    if (item.kind === "command") {
      post({ type: "runCommand", name: item.name, args: "" });
      return;
    }
    if (item.kind === "skill") {
      // Skills are not commands in v2.3.0's verified surface. Insert a
      // prompt that names the skill so the agent can activate it.
      inputEl.value = 'Use the skill "' + item.name + '": ';
      resizeTextarea();
      inputEl.focus();
    }
  }

  slashPalette.addEventListener("click", function (event) {
    var item = event.target.closest("[data-index]");
    if (!item) return;
    chooseSlash(Number(item.dataset.index));
  });

  /* ------------------------------------------------------------------ */
  /* Banner                                                             */
  /* ------------------------------------------------------------------ */

  var BANNER_ICONS = { error: "⚠", auth: "🔒", warning: "⚠", info: "ℹ" };

  function renderBanner(banner) {
    if (!banner) {
      bannerEl.hidden = true;
      bannerActions.innerHTML = "";
      return;
    }
    bannerEl.hidden = false;
    bannerEl.className = "banner banner-" + (banner.kind || "info");
    bannerIcon.textContent = BANNER_ICONS[banner.kind] || "ℹ";
    bannerMessage.textContent = banner.message || "";
    bannerMessage.dir = "auto";

    if (banner.details) {
      bannerDetails.textContent = banner.details;
      bannerDetailsWrap.hidden = false;
    } else {
      bannerDetails.textContent = "";
      bannerDetailsWrap.hidden = true;
    }

    bannerActions.innerHTML = "";
    var actions = Array.isArray(banner.actions) ? banner.actions : [];
    actions.forEach(function (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "banner-btn";
      button.dataset.action = action.id;
      button.textContent = action.label;
      bannerActions.appendChild(button);
    });
    bannerActions.hidden = actions.length === 0;
  }

  bannerActions.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button) return;
    post({ type: "bannerAction", action: button.dataset.action });
  });

  bannerDismiss.addEventListener("click", function () {
    renderBanner(null);
    post({ type: "dismissBanner" });
  });

  /* ------------------------------------------------------------------ */
  /* Status + generating state                                          */
  /* ------------------------------------------------------------------ */

  function setGenerating(value) {
    state.generating = !!value;
    btnSend.textContent = state.generating ? "Stop" : "Send";
    btnSend.classList.toggle("stop", state.generating);
    btnSend.setAttribute("aria-label", state.generating ? "Stop generating" : "Send message");
    btnStop.hidden = !state.generating;
    composer.classList.toggle("generating", state.generating);
  }

  function setStatus(status, message, generating, canCancel) {
    var text = message || "";
    statusText.textContent = text;
    statusEl.className = "status status-" + (status || "idle");
    if (typeof generating === "boolean") setGenerating(generating);
    btnCancelWait.hidden = !canCancel;
    statusEl.hidden = !text && !canCancel;
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                           */
  /* ------------------------------------------------------------------ */

  function formatTime(created) {
    try {
      return new Date(created || Date.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_err) {
      return "";
    }
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  }

  function scrollToBottom(force) {
    window.requestAnimationFrame(function () {
      if (force || isNearBottom()) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        jumpLatest.hidden = true;
      } else if (messagesEl.children.length > 0) {
        jumpLatest.hidden = false;
      }
    });
  }

  messagesEl.addEventListener("scroll", function () {
    jumpLatest.hidden = isNearBottom() || messagesEl.children.length === 0;
  });

  jumpLatest.addEventListener("click", function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpLatest.hidden = true;
  });

  function updateEmptyState() {
    emptyStateEl.hidden = messagesEl.children.length > 0;
  }

  function createMessage(role, id, created) {
    var article = document.createElement("article");
    article.className = "msg msg-" + role;
    if (id) article.id = id;

    var roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = role === "user" ? "You" : "OpenCode";

    var meta = document.createElement("div");
    meta.className = "msg-meta";

    var body = document.createElement("div");
    body.className = "msg-body";
    body.dir = "auto";

    var time = document.createElement("time");
    time.className = "msg-time";
    time.dateTime = new Date(created || Date.now()).toISOString();
    time.textContent = formatTime(created);

    article.appendChild(roleEl);
    article.appendChild(meta);
    article.appendChild(body);
    article.appendChild(time);
    return { article: article, body: body, time: time, meta: meta };
  }

  function updateMessageMeta(meta, agent, model) {
    if (!meta) return;
    var bits = [];
    if (agent) bits.push(agent);
    if (model && model.providerID) {
      var text = model.providerID + "/" + model.modelID;
      if (model.variant) text += " · " + model.variant;
      bits.push(text);
    }
    meta.textContent = bits.join(" · ");
    meta.dir = "auto";
    meta.hidden = bits.length === 0;
  }

  function appendUserMessage(id, text, created) {
    var parts = createMessage("user", id, created);
    parts.meta.hidden = true;
    parts.body.innerHTML = renderMarkdown(text);
    messagesEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(true);
  }

  function thinkingSummary(elapsedMs, open) {
    return "Thinking" + (elapsedMs != null ? " · " + formatDuration(elapsedMs) : "") + (open ? "" : "");
  }

  function makeThinking(text, elapsedMs, collapsed) {
    var details = document.createElement("details");
    details.className = "thinking";
    if (!collapsed) details.open = true;
    var summary = document.createElement("summary");
    summary.className = "thinking-summary";
    summary.textContent = thinkingSummary(elapsedMs, !collapsed);
    var pre = document.createElement("div");
    pre.className = "thinking-text";
    pre.dir = "auto";
    pre.textContent = text || "";
    details.appendChild(summary);
    details.appendChild(pre);
    return { details: details, summary: summary, text: pre };
  }

  function toolIcon(kind) {
    switch (kind) {
      case "read": return "👁";
      case "edit": return "✎";
      case "write": return "✚";
      case "bash": return "$";
      case "search": return "⌕";
      case "web": return "🌐";
      case "subagent": return "⑃";
      case "todo": return "☑";
      default: return "⚙";
    }
  }

  /* Mirrors src/chatController.ts toolTitle/toolKind for restored history. */
  function inferToolKind(name) {
    var n = String(name || "").toLowerCase();
    if (n.indexOf("todo") !== -1) return "todo";
    if (n.indexOf("read") !== -1) return "read";
    if (n.indexOf("edit") !== -1 || n.indexOf("patch") !== -1) return "edit";
    if (n.indexOf("write") !== -1) return "write";
    if (n.indexOf("bash") !== -1 || n.indexOf("shell") !== -1 || n.indexOf("terminal") !== -1) return "bash";
    if (n.indexOf("grep") !== -1 || n.indexOf("glob") !== -1 || n.indexOf("search") !== -1) {
      return n.indexOf("web") !== -1 ? "web" : "search";
    }
    if (n.indexOf("web") !== -1 || n.indexOf("fetch") !== -1) return "web";
    if (n.indexOf("task") !== -1 || n.indexOf("subagent") !== -1) return "subagent";
    return "tool";
  }

  function inferToolTitle(tool) {
    if (!tool) return "";
    if (typeof tool.input === "string") return tool.input.slice(0, 120);
    var input = tool.input && typeof tool.input === "object" ? tool.input : {};
    var name = String(tool.name || "").toLowerCase();
    function pick() {
      for (var i = 0; i < arguments.length; i += 1) {
        var value = input[arguments[i]];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return undefined;
    }
    if (name === "shell" || name === "bash") return pick("command", "cmd") || "";
    if (name === "read" || name === "write" || name === "edit" || name === "patch") {
      return pick("path", "filePath", "file_path", "filename") || "";
    }
    if (name === "grep" || name === "glob") {
      var pattern = pick("pattern", "query");
      var scope = pick("path", "include");
      return pattern ? (scope ? pattern + " in " + scope : pattern) : "";
    }
    if (name === "webfetch" || name === "fetch") return pick("url") || "";
    if (name === "websearch" || name === "search") return pick("query", "q") || "";
    if (name === "task" || name === "subagent") return pick("description", "prompt") || "";
    if (name === "todowrite" || name === "todo") return "Update todos";
    return pick("description", "title", "path", "command", "query", "url") || "";
  }

  function inferToolFiles(tool) {
    var files = [];
    function add(value) {
      if (typeof value === "string" && value.trim() && files.indexOf(value.trim()) === -1) {
        files.push(value.trim());
      }
    }
    if (tool && tool.input && typeof tool.input === "object") {
      ["path", "filePath", "file_path", "filename"].forEach(function (key) {
        add(tool.input[key]);
      });
    }
    if (tool && tool.metadata && typeof tool.metadata === "object") {
      ["outputPaths", "files"].forEach(function (key) {
        if (Array.isArray(tool.metadata[key])) tool.metadata[key].forEach(add);
      });
    }
    return files;
  }

  function makeToolCard(tool) {
    var card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolId = tool.id || "";
    var head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    head.setAttribute("aria-expanded", "false");
    head.appendChild(makeEl("span", "tool-icon", toolIcon(tool.kind || inferToolKind(tool.name))));
    head.appendChild(makeEl("span", "tool-name", tool.name || "tool"));
    var title = makeEl("span", "tool-title", tool.title || inferToolTitle(tool));
    title.dir = "auto";
    head.appendChild(title);
    var status = makeEl("span", "tool-status", tool.status || "pending");
    head.appendChild(status);
    head.appendChild(makeEl("span", "tool-chevron", "▾"));
    var body = document.createElement("div");
    body.className = "tool-body";
    body.hidden = true;
    card.appendChild(head);
    card.appendChild(body);
    updateToolCard(card, tool);
    return card;
  }

  function updateToolCard(card, tool) {
    if (!card) return;
    card.dataset.status = tool.status || "pending";
    var status = card.querySelector(".tool-status");
    if (status) status.textContent = tool.status || "pending";
    var title = card.querySelector(".tool-title");
    if (title) {
      title.textContent = tool.title || inferToolTitle(tool);
      title.dir = "auto";
    }
    var body = card.querySelector(".tool-body");
    if (!body) return;
    body.innerHTML = "";

    var input = tool.input;
    if (input && (typeof input !== "object" || Object.keys(input).length > 0)) {
      var inputWrap = document.createElement("div");
      inputWrap.className = "tool-section";
      inputWrap.appendChild(makeEl("div", "tool-label", "Input"));
      var inputPre = document.createElement("pre");
      inputPre.className = "tool-pre";
      inputPre.textContent =
        typeof input === "string" ? input : JSON.stringify(input, null, 2);
      inputWrap.appendChild(inputPre);
      body.appendChild(inputWrap);
    }

    var files = Array.isArray(tool.files) ? tool.files : [];
    if (files.length > 0) {
      var filesWrap = document.createElement("div");
      filesWrap.className = "tool-section tool-files";
      filesWrap.appendChild(makeEl("div", "tool-label", "Files"));
      files.forEach(function (file) {
        var row = document.createElement("div");
        row.className = "tool-file-row";
        var open = document.createElement("button");
        open.type = "button";
        open.className = "file-link";
        open.dataset.openFile = file;
        open.textContent = file;
        open.dir = "auto";
        row.appendChild(open);
        var diff = document.createElement("button");
        diff.type = "button";
        diff.className = "file-diff";
        diff.dataset.openDiff = file;
        diff.textContent = "diff";
        row.appendChild(diff);
        filesWrap.appendChild(row);
      });
      body.appendChild(filesWrap);
    }

    if (Array.isArray(tool.content) && tool.content.length > 0) {
      var out = document.createElement("div");
      out.className = "tool-section";
      out.appendChild(makeEl("div", "tool-label", "Output"));
      var outPre = document.createElement("pre");
      outPre.className = "tool-pre tool-output";
      outPre.textContent = tool.content
        .map(function (c) {
          if (typeof c.text === "string") return c.text;
          try {
            return JSON.stringify(c);
          } catch (_err) {
            return String(c);
          }
        })
        .join("\n");
      out.appendChild(outPre);
      body.appendChild(out);
    }

    if (tool.error) {
      var err = makeEl("div", "tool-error", tool.error);
      err.dir = "auto";
      body.appendChild(err);
    }
  }

  function ensureStreamParts() {
    if (!stream.body) return;
    if (stream.answers) return;
    stream.thinking = null;
    stream.toolList = makeEl("div", "tool-list");
    stream.answers = makeEl("div", "answer");
    stream.answers.dir = "auto";
    var files = makeEl("div", "files-summary");
    files.hidden = true;
    stream.body.innerHTML = "";
    stream.body.appendChild(stream.toolList);
    stream.body.appendChild(stream.answers);
    stream.body.appendChild(files);
    stream.answers.innerHTML =
      '<div class="typing" role="status" aria-label="OpenCode is typing">' +
      "<span></span><span></span><span></span></div>";
  }

  function startAssistant(id, agent, model) {
    if (stream.el) endAssistant();
    var stick = isNearBottom();
    var parts = createMessage("assistant", id, Date.now());
    parts.article.classList.add("streaming");
    updateMessageMeta(parts.meta, agent, model);
    messagesEl.appendChild(parts.article);
    resetStream();
    stream = {
      el: parts.article,
      body: parts.body,
      id: id,
      text: "",
      reasoning: null,
      tools: new Map(),
      answers: null,
      thinking: null,
      toolList: null,
      files: new Map(),
      meta: parts.meta,
    };
    ensureStreamParts();
    updateEmptyState();
    scrollToBottom(stick);
  }

  function updateAssistant(id, fullText) {
    if (!stream.el || stream.id !== id) startAssistant(id);
    if (!stream.el) return;
    var stick = isNearBottom();
    ensureStreamParts();
    stream.text = fullText || "";
    stream.answers.innerHTML = renderMarkdown(stream.text);
    if (stream.reasoning && stream.reasoning.details.open && stream.text.trim()) {
      stream.reasoning.details.open = false;
    }
    stream.el.classList.remove("streaming");
    scrollToBottom(stick);
  }

  function endAssistant(id) {
    if (!stream.el) return;
    if (id && stream.id !== id) return;
    stream.el.classList.remove("streaming");
    resetStream();
  }

  function renderHistoryMessage(message) {
    if (message.role !== "assistant") {
      appendUserMessage(message.id, message.text || "", message.created);
      return;
    }
    var stick = isNearBottom();
    var parts = createMessage("assistant", message.id, message.created);
    updateMessageMeta(parts.meta, message.agent, message.model);
    var body = parts.body;
    var content = Array.isArray(message.parts) ? message.parts : null;
    if (!content) {
      body.innerHTML = renderMarkdown(message.text || "");
    } else {
      var toolList = null;
      content.forEach(function (part) {
        if (part.type === "reasoning") {
          var elapsed = part.completed && part.created ? part.completed - part.created : null;
          var thinking = makeThinking(part.text || "", elapsed, true);
          body.appendChild(thinking.details);
        } else if (part.type === "tool") {
          if (!toolList) {
            toolList = makeEl("div", "tool-list");
            body.appendChild(toolList);
          }
          var tool = {
            id: part.id,
            name: part.name,
            title: inferToolTitle(part),
            kind: inferToolKind(part.name),
            status: part.status === "completed" ? "done" : part.status === "error" ? "failed" : part.status,
            input: part.input,
            content: part.content,
            error: part.error,
            files: inferToolFiles(part),
          };
          var card = makeToolCard(tool);
          toolList.appendChild(card);
        } else if (part.type === "text") {
          var answer = makeEl("div", "answer");
          answer.dir = "auto";
          answer.innerHTML = renderMarkdown(part.text || "");
          body.appendChild(answer);
        }
      });
      if (!body.textContent.trim() && message.text) {
        var fallback = makeEl("div", "answer");
        fallback.innerHTML = renderMarkdown(message.text);
        body.appendChild(fallback);
      }
    }
    if (Array.isArray(message.files) && message.files.length > 0) {
      body.appendChild(makeFilesSummary(message.files));
    }
    messagesEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(stick);
  }

  function renderHistory(history) {
    messagesEl.innerHTML = "";
    resetStream();
    codeStore.clear();
    (history || []).forEach(renderHistoryMessage);
    updateEmptyState();
    scrollToBottom(true);
  }

  function makeFilesSummary(files) {
    var wrap = document.createElement("div");
    wrap.className = "files-summary";
    wrap.appendChild(makeEl("div", "files-title", "Files changed"));
    files.forEach(function (file) {
      var row = document.createElement("div");
      row.className = "tool-file-row";
      var open = document.createElement("button");
      open.type = "button";
      open.className = "file-link";
      open.dataset.openFile = file;
      open.textContent = file;
      open.dir = "auto";
      row.appendChild(open);
      var diff = document.createElement("button");
      diff.type = "button";
      diff.className = "file-diff";
      diff.dataset.openDiff = file;
      diff.textContent = "diff";
      row.appendChild(diff);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function showFilesChanged(files) {
    if (!stream.el || !Array.isArray(files) || files.length === 0) return;
    ensureStreamParts();
    files.forEach(function (f) {
      stream.files.set(f, f);
    });
    var stick = isNearBottom();
    var existing = stream.body.querySelector(".files-summary");
    if (existing) existing.remove();
    stream.body.appendChild(makeFilesSummary(Array.from(stream.files.values())));
    scrollToBottom(stick);
  }

  /* ------------------------------------------------------------------ */
  /* Permission cards                                                   */
  /* ------------------------------------------------------------------ */

  function permissionLabel(action) {
    var map = {
      read: "Read file",
      write: "Write file",
      edit: "Edit file",
      shell: "Run command",
      bash: "Run command",
      webfetch: "Fetch URL",
      websearch: "Web search",
      question: "Ask a question",
    };
    return map[action] || action || "Permission";
  }

  function removePermissionCard(requestID) {
    var card = messagesEl.querySelector(
      '.msg-permission [data-request-id="' + String(requestID).replace(/"/g, "") + '"]'
    );
    if (card) {
      var article = card.closest(".msg");
      if (article) article.remove();
    }
    state.permissions.delete(requestID);
  }

  function appendPermissionRequest(request) {
    if (!request || !request.id) return;
    if (state.permissions.has(request.id)) {
      removePermissionCard(request.id);
    }
    state.permissions.set(request.id, request);
    var article = document.createElement("article");
    article.className = "msg msg-permission";
    article.setAttribute("role", "alertdialog");
    article.setAttribute("aria-label", "Permission request");
    article.dataset.requestId = request.id;

    var roleEl = makeEl("div", "msg-role", "Permission needed");
    var body = document.createElement("div");
    body.className = "msg-body permission-body";
    body.dir = "auto";

    var title = makeEl("div", "permission-title", permissionLabel(request.action));
    body.appendChild(title);

    if (request.message) {
      var msg = makeEl("div", "permission-message", request.message);
      msg.dir = "auto";
      body.appendChild(msg);
    }

    if (Array.isArray(request.resources) && request.resources.length > 0) {
      var res = document.createElement("ul");
      res.className = "permission-resources";
      request.resources.forEach(function (resource) {
        var li = document.createElement("li");
        li.textContent = resource;
        li.dir = "auto";
        res.appendChild(li);
      });
      body.appendChild(res);
    }

    if (Array.isArray(request.save) && request.save.length > 0) {
      var save = makeEl("div", "permission-save", "Always would save: " + request.save.join(", "));
      save.dir = "auto";
      body.appendChild(save);
    }

    var actions = document.createElement("div");
    actions.className = "permission-actions";
    [
      { decision: "once", label: "Allow once", className: "primary" },
      { decision: "always", label: "Allow always", className: "" },
      { decision: "reject", label: "Reject", className: "danger" },
    ].forEach(function (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "banner-btn " + action.className;
      button.dataset.decision = action.decision;
      button.textContent = action.label;
      actions.appendChild(button);
    });
    body.appendChild(actions);

    article.appendChild(roleEl);
    article.appendChild(body);
    messagesEl.appendChild(article);
    updateEmptyState();
    scrollToBottom(true);
  }

  /* ------------------------------------------------------------------ */
  /* Question forms                                                     */
  /* ------------------------------------------------------------------ */

  function fieldVisible(field, values) {
    if (!Array.isArray(field.when) || field.when.length === 0) return true;
    return field.when.every(function (cond) {
      var value = values[cond.key];
      if (cond.op === "neq") return value !== cond.value;
      return value === cond.value;
    });
  }

  function makeFormField(field, values, onChange) {
    var wrap = document.createElement("div");
    wrap.className = "form-field";
    wrap.dataset.key = field.key;
    if (field.hidden) wrap.hidden = true;

    var label = makeEl("label", "form-label", field.title || field.key);
    label.setAttribute("for", "field_" + field.key);
    wrap.appendChild(label);

    if (field.description) {
      var desc = makeEl("div", "form-desc", field.description);
      desc.dir = "auto";
      wrap.appendChild(desc);
    }

    var input;
    if (Array.isArray(field.options) && field.options.length > 0 && field.type !== "multiselect") {
      input = document.createElement("select");
      input.id = "field_" + field.key;
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose…";
      input.appendChild(placeholder);
      field.options.forEach(function (option) {
        var opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        input.appendChild(opt);
      });
      input.addEventListener("change", function () {
        values[field.key] = input.value;
        onChange && onChange();
      });
    } else if (field.type === "multiselect" && Array.isArray(field.options)) {
      input = document.createElement("div");
      input.className = "form-multiselect";
      input.id = "field_" + field.key;
      var selected = [];
      field.options.forEach(function (option) {
        var row = document.createElement("label");
        row.className = "form-check";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = option.value;
        checkbox.addEventListener("change", function () {
          selected = field.options
            .filter(function (o, index) {
              return input.querySelectorAll("input[type=checkbox]")[index].checked;
            })
            .map(function (o) {
              return o.value;
            });
          values[field.key] = selected;
          onChange && onChange();
        });
        row.appendChild(checkbox);
        row.appendChild(document.createTextNode(option.label));
        input.appendChild(row);
      });
    } else if (field.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.id = "field_" + field.key;
      input.addEventListener("change", function () {
        values[field.key] = input.checked;
        onChange && onChange();
      });
    } else if (field.type === "number" || field.type === "integer") {
      input = document.createElement("input");
      input.type = "number";
      input.step = field.type === "integer" ? "1" : "any";
      input.id = "field_" + field.key;
      input.placeholder = field.placeholder || "";
      input.addEventListener("input", function () {
        values[field.key] = input.value === "" ? undefined : Number(input.value);
        onChange && onChange();
      });
    } else {
      input = document.createElement("input");
      input.type = field.format === "email" ? "email" : field.format === "uri" ? "url" : "text";
      input.id = "field_" + field.key;
      input.placeholder = field.placeholder || "";
      input.dir = "auto";
      input.addEventListener("input", function () {
        values[field.key] = input.value;
        onChange && onChange();
      });
    }
    if (field.default !== undefined && input && "value" in input) {
      input.value = String(field.default);
      values[field.key] = field.default;
    }
    wrap.appendChild(input);
    if (field.custom && Array.isArray(field.options)) {
      var custom = document.createElement("input");
      custom.type = "text";
      custom.className = "form-custom";
      custom.placeholder = "Other…";
      custom.dir = "auto";
      custom.addEventListener("input", function () {
        if (custom.value) values[field.key] = custom.value;
        onChange && onChange();
      });
      wrap.appendChild(custom);
    }
    return wrap;
  }

  function appendQuestionRequest(form) {
    if (!form || !form.id) return;
    state.forms.set(form.id, form);
    var article = document.createElement("article");
    article.className = "msg msg-question";
    article.setAttribute("role", "alertdialog");
    article.setAttribute("aria-label", "Question");
    article.dataset.formId = form.id;

    var roleEl = makeEl("div", "msg-role", "Question");
    var body = document.createElement("div");
    body.className = "msg-body question-body";
    body.dir = "auto";
    body.appendChild(makeEl("div", "permission-title", form.title || "A question from OpenCode"));

    var values = {};
    var fields = Array.isArray(form.fields) ? form.fields : [];
    var fieldWraps = [];
    fields.forEach(function (field) {
      var wrap = makeFormField(field, values, function () {
        fieldWraps.forEach(function (entry) {
          entry.el.hidden = entry.field.hidden || !fieldVisible(entry.field, values);
        });
      });
      fieldWraps.push({ field: field, el: wrap });
      body.appendChild(wrap);
    });
    fieldWraps.forEach(function (entry) {
      entry.el.hidden = entry.field.hidden || !fieldVisible(entry.field, values);
    });

    var actions = document.createElement("div");
    actions.className = "permission-actions";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "banner-btn primary";
    submit.textContent = "Submit";
    submit.dataset.submitForm = form.id;
    actions.appendChild(submit);
    body.appendChild(actions);

    article.appendChild(roleEl);
    article.appendChild(body);
    messagesEl.appendChild(article);
    updateEmptyState();
    scrollToBottom(true);
  }

  function removeQuestionCard(formID) {
    var article = messagesEl.querySelector(
      '.msg-question[data-form-id="' + String(formID).replace(/"/g, "") + '"]'
    );
    if (article) article.remove();
    state.forms.delete(formID);
  }

  function collectFormAnswer(formID) {
    var article = messagesEl.querySelector(
      '.msg-question[data-form-id="' + String(formID).replace(/"/g, "") + '"]'
    );
    if (!article) return null;
    var form = state.forms.get(formID);
    var answer = {};
    if (form && Array.isArray(form.fields)) {
      form.fields.forEach(function (field) {
        var wrap = article.querySelector('.form-field[data-key="' + field.key + '"]');
        if (!wrap) return;
        var select = wrap.querySelector("select");
        var checkboxes = wrap.querySelectorAll('input[type="checkbox"]');
        var input = wrap.querySelector('input[type="number"], input[type="text"], input[type="email"], input[type="url"]');
        var custom = wrap.querySelector(".form-custom");
        if (select) {
          if (select.value) answer[field.key] = select.value;
        } else if (field.type === "multiselect") {
          var chosen = [];
          checkboxes.forEach(function (cb) {
            if (cb.checked) chosen.push(cb.value);
          });
          answer[field.key] = chosen;
        } else if (field.type === "boolean") {
          answer[field.key] = checkboxes.length > 0 && checkboxes[0].checked;
        } else if (custom && custom.value) {
          answer[field.key] = custom.value;
        } else if (input && input.value !== "") {
          answer[field.key] =
            field.type === "number" || field.type === "integer" ? Number(input.value) : input.value;
        }
      });
    }
    return answer;
  }

  function appendPromptFailure(message, details) {
    var article = document.createElement("article");
    article.className = "msg msg-error";
    var roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = "Error";
    var body = document.createElement("div");
    body.className = "msg-body";
    body.dir = "auto";
    body.textContent = message || "Request failed";
    article.appendChild(roleEl);
    article.appendChild(body);
    if (details && details !== message) {
      var detailsEl = document.createElement("details");
      detailsEl.className = "msg-details";
      var summary = document.createElement("summary");
      summary.textContent = "Details";
      var pre = document.createElement("pre");
      pre.textContent = details;
      detailsEl.appendChild(summary);
      detailsEl.appendChild(pre);
      article.appendChild(detailsEl);
    }
    messagesEl.appendChild(article);
    updateEmptyState();
    scrollToBottom(true);
  }

  /* Delegated handlers for generated Markdown/code content. */
  messagesEl.addEventListener("click", function (event) {
    var decision = event.target.closest("[data-decision]");
    if (decision) {
      var permArticle = decision.closest(".msg-permission");
      if (permArticle) {
        var requestID = permArticle.dataset.requestId;
        var chosen = decision.dataset.decision;
        permArticle.querySelectorAll("button").forEach(function (btn) {
          btn.disabled = true;
        });
        post({ type: "replyPermission", requestID: requestID, decision: chosen });
      }
      return;
    }

    var submitForm = event.target.closest("[data-submit-form]");
    if (submitForm) {
      var formID = submitForm.dataset.submitForm;
      var answer = collectFormAnswer(formID);
      if (answer) {
        submitForm.disabled = true;
        post({ type: "replyForm", formID: formID, answer: answer });
      }
      return;
    }

    var openFile = event.target.closest("[data-open-file]");
    if (openFile) {
      post({ type: "openFile", path: openFile.dataset.openFile });
      return;
    }

    var openDiff = event.target.closest("[data-open-diff]");
    if (openDiff) {
      post({ type: "openDiff", path: openDiff.dataset.openDiff });
      return;
    }

    var toolHead = event.target.closest(".tool-head");
    if (toolHead) {
      var toolCard = toolHead.closest(".tool-card");
      if (toolCard) {
        var toolBody = toolCard.querySelector(".tool-body");
        if (toolBody) {
          toolBody.hidden = !toolBody.hidden;
          toolHead.setAttribute("aria-expanded", String(!toolBody.hidden));
        }
      }
      return;
    }

    var copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      var copyId = copyButton.dataset.copy;
      var raw = codeStore.has(copyId) ? codeStore.get(copyId) : "";
      var original = copyButton.textContent;
      copyText(raw)
        .then(function () {
          copyButton.textContent = "Copied!";
          window.setTimeout(function () {
            copyButton.textContent = original;
          }, 1200);
        })
        .catch(function () {
          if (fallbackCopy(raw)) {
            copyButton.textContent = "Copied!";
          } else {
            copyButton.textContent = "Failed";
          }
          window.setTimeout(function () {
            copyButton.textContent = original;
          }, 1200);
        });
      return;
    }

    var wrapButton = event.target.closest("[data-wrap]");
    if (wrapButton) {
      var block = wrapButton.closest(".code-block");
      if (block) {
        var wrapped = block.classList.toggle("wrap");
        wrapButton.textContent = wrapped ? "Unwrap" : "Wrap";
      }
      return;
    }

    var link = event.target.closest("a[data-external]");
    if (link) {
      event.preventDefault();
      post({ type: "openLink", url: link.getAttribute("href") });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Composer                                                           */
  /* ------------------------------------------------------------------ */

  function resizeTextarea() {
    inputEl.style.height = "auto";
    var lineHeight = parseFloat(window.getComputedStyle(inputEl).lineHeight) || 20;
    var maxHeight = lineHeight * 8;
    var next = Math.min(inputEl.scrollHeight, maxHeight);
    inputEl.style.height = next + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || state.generating) return;
    inputEl.value = "";
    resizeTextarea();
    post({ type: "send", text: text });
  }

  inputEl.addEventListener("input", function () {
    resizeTextarea();
    state.slashIndex = 0;
    renderSlash();
  });
  inputEl.addEventListener("keydown", function (event) {
    if (!slashPalette.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (state.slashItems.length > 0) {
          var delta = event.key === "ArrowDown" ? 1 : -1;
          state.slashIndex =
            (state.slashIndex + delta + state.slashItems.length) % state.slashItems.length;
          renderSlash();
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseSlash(state.slashIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      post({ type: "cycleAgent", step: -1 });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.ctrlKey && event.key === ".") {
      event.preventDefault();
      post({ type: "cycleAgent", step: 1 });
    }
  });

  composer.addEventListener("submit", function (event) {
    event.preventDefault();
    if (state.generating) {
      post({ type: "stop" });
      return;
    }
    send();
  });

  btnStop.addEventListener("click", function () {
    post({ type: "stop" });
  });

  btnCancelWait.addEventListener("click", function () {
    post({ type: "stop" });
  });

  btnNewChat.addEventListener("click", function () {
    messagesEl.innerHTML = "";
    updateEmptyState();
    setStatus("idle", "", false, false);
    renderBanner(null);
    post({ type: "newChat" });
  });

  btnRefresh.addEventListener("click", function () {
    post({ type: "refreshProviders" });
  });

  btnKey.addEventListener("click", function () {
    post({ type: "setPassword" });
  });

  emptyStateEl.addEventListener("click", function (event) {
    var chip = event.target.closest("[data-suggestion]");
    if (!chip || state.generating) return;
    post({ type: "send", text: chip.dataset.suggestion });
  });

  /* ------------------------------------------------------------------ */
  /* Extension -> webview                                               */
  /* ------------------------------------------------------------------ */

  window.addEventListener("message", function (event) {
    var message = event.data || {};
    switch (message.type) {
      case "init": {
        state.sessionID = message.sessionID || null;
        state.models = Array.isArray(message.models) ? message.models : [];
        state.selectedModel = message.selectedModel || null;
        state.agents = Array.isArray(message.agents) ? message.agents : [];
        state.agent = message.agent || state.agent;
        state.commands = Array.isArray(message.commands) ? message.commands : [];
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.mode = message.mode || "managed";
        updateHeaderInfo(message);
        updateModelLabel();
        updateAgentLabel();
        updateVariantControl();
        if (!modelPopover.hidden) renderModelList();
        if (!agentPopover.hidden) renderAgentList();
        btnKey.hidden = state.mode !== "external";
        renderBanner(message.banner || null);
        if (!state.generating) renderHistory(message.history || []);
        setStatus(
          message.generating ? "thinking" : "idle",
          "",
          !!message.generating,
          false
        );
        break;
      }
      case "model-selected": {
        state.selectedModel = message.selectedModel || null;
        updateModelLabel();
        updateVariantControl();
        if (!modelPopover.hidden) renderModelList();
        closePopover();
        break;
      }
      case "agent-selected": {
        if (message.agent) state.agent = message.agent;
        updateAgentLabel();
        if (!agentPopover.hidden) renderAgentList();
        closeAgents();
        break;
      }
      case "sessions": {
        state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        state.sessionsCursor = message.cursor || null;
        if (message.currentSessionID) state.sessionID = message.currentSessionID;
        if (!sessionPanel.hidden) renderSessions();
        updateSessionLabel();
        break;
      }
      case "session-selected": {
        state.sessionID = message.sessionID || null;
        if (message.agent) state.agent = message.agent;
        if (message.selectedModel) state.selectedModel = message.selectedModel;
        updateAgentLabel();
        updateModelLabel();
        updateVariantControl();
        updateSessionLabel();
        renderHistory(message.history || []);
        setStatus("idle", "", false, false);
        break;
      }
      case "history": {
        renderHistory(message.history || []);
        break;
      }
      case "context": {
        renderContext(message);
        break;
      }
      case "compaction": {
        renderCompaction(message.compaction);
        break;
      }
      case "permission-request": {
        appendPermissionRequest(message.request);
        break;
      }
      case "permission-resolved": {
        removePermissionCard(message.requestID);
        break;
      }
      case "permission-error": {
        var permErr = message.message || "Permission request failed";
        var permCard = messagesEl.querySelector(
          '.msg-permission[data-request-id="' + String(message.requestID || "").replace(/"/g, "") + '"]'
        );
        if (permCard) {
          permCard.querySelectorAll("button").forEach(function (button) {
            button.disabled = false;
          });
        }
        appendPromptFailure(permErr, permErr);
        break;
      }
      case "question-request": {
        appendQuestionRequest(message.form);
        break;
      }
      case "question-resolved": {
        removeQuestionCard(message.formID);
        break;
      }
      case "question-error": {
        var formErr = message.message || "Question reply failed";
        var formCard = messagesEl.querySelector(
          '.msg-question[data-form-id="' + String(message.formID || "").replace(/"/g, "") + '"]'
        );
        if (formCard) {
          formCard.querySelectorAll("button").forEach(function (button) {
            button.disabled = false;
          });
        }
        appendPromptFailure(formErr, formErr);
        break;
      }
      case "reasoning-start": {
        if (!stream.el || (message.messageID && stream.id !== message.messageID)) {
          startAssistant(message.messageID, state.agent, state.selectedModel);
        }
        ensureStreamParts();
        if (!stream.reasoning) {
          var thinking = makeThinking("", null, false);
          stream.reasoning = thinking;
          stream.body.insertBefore(thinking.details, stream.body.firstChild);
        }
        break;
      }
      case "reasoning-delta": {
        if (!stream.el) startAssistant(message.messageID, state.agent, state.selectedModel);
        ensureStreamParts();
        if (!stream.reasoning) {
          var rt = makeThinking("", null, false);
          stream.reasoning = rt;
          stream.body.insertBefore(rt.details, stream.body.firstChild);
        }
        stream.reasoning.text.textContent = message.text || "";
        break;
      }
      case "reasoning-end": {
        if (stream.reasoning) {
          if (message.text) stream.reasoning.text.textContent = message.text;
          stream.reasoning.summary.textContent = thinkingSummary(message.elapsedMs, false);
          stream.reasoning.details.open = false;
        }
        break;
      }
      case "tool-start":
      case "tool-update": {
        if (!stream.el) startAssistant(message.messageID, state.agent, state.selectedModel);
        ensureStreamParts();
        var tool = message.tool || {};
        var card = stream.tools.get(tool.id);
        if (!card) {
          card = makeToolCard(tool);
          stream.tools.set(tool.id, card);
          stream.toolList.appendChild(card);
        } else {
          updateToolCard(card, tool);
        }
        break;
      }
      case "files-changed": {
        showFilesChanged(message.files || []);
        break;
      }
      case "server-info": {
        updateHeaderInfo(message);
        break;
      }
      case "session": {
        if (message.sessionID) state.sessionID = message.sessionID;
        break;
      }
      case "status": {
        setStatus(message.status, message.message, message.generating, message.canCancel);
        break;
      }
      case "user-message": {
        appendUserMessage(message.id, message.text || "", message.created);
        break;
      }
      case "assistant-start": {
        startAssistant(
          message.messageID,
          message.agent || state.agent,
          message.model || state.selectedModel
        );
        break;
      }
      case "assistant-delta": {
        updateAssistant(message.messageID, message.text || "");
        break;
      }
      case "assistant-end": {
        endAssistant(message.messageID);
        break;
      }
      case "banner": {
        renderBanner(message.banner || null);
        break;
      }
      case "prompt-failed": {
        appendPromptFailure(message.message, message.details);
        break;
      }
      case "connection": {
        if (message.state === "reconnecting" && !state.generating) {
          setStatus("waiting", "Reconnecting to OpenCode…", false, false);
        }
        break;
      }
      default:
        // Unknown messages are ignored on purpose.
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Ready handshake                                                    */
  /* ------------------------------------------------------------------ */

  resizeTextarea();
  post({ type: "ready" });
})();
