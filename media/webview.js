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
  var StreamRender = window.OcStream;
  var UiState = window.OcUiState;

  var headerEl = document.getElementById("header");
  var messagesEl = document.getElementById("messages");
  var messagesContentEl = document.getElementById("messagesContent");
  var emptyStateEl = document.getElementById("emptyState");
  var inputEl = document.getElementById("input");
  var composer = document.getElementById("composer");
  var composerCard = document.getElementById("composerCard");
  var composerToolbar = document.getElementById("composerToolbar");
  var composerNote = document.getElementById("composerNote");
  var btnSend = document.getElementById("btnSend");
  var sendIcon = document.getElementById("sendIcon");
  var btnNewChat = document.getElementById("btnNewChat");
  var btnRefresh = document.getElementById("btnRefresh");
  var btnKey = document.getElementById("btnKey");
  var btnAttach = document.getElementById("btnAttach");
  var btnMore = document.getElementById("btnMore");
  var btnCancelWait = document.getElementById("btnCancelWait");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("statusText");
  var jumpLatest = document.getElementById("jumpLatest");
  var attachChips = document.getElementById("attachChips");

  var btnModel = document.getElementById("btnModel");
  var modelLabel = document.getElementById("modelLabel");
  var modelPopover = document.getElementById("modelPopover");
  var modelSearch = document.getElementById("modelSearch");
  var modelList = document.getElementById("modelList");
  var welcomeModel = document.getElementById("welcomeModel");

  var btnAgent = document.getElementById("btnAgent");
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
  var btnThinking = document.getElementById("btnThinking");
  var thinkingLabel = document.getElementById("thinkingLabel");
  var thinkingPopover = document.getElementById("thinkingPopover");
  var thinkingList = document.getElementById("thinkingList");
  var morePopover = document.getElementById("morePopover");
  var thinkingMoreList = document.getElementById("thinkingMoreList");

  var btnContext = document.getElementById("btnContext");
  var contextPopover = document.getElementById("contextPopover");
  var contextRingValue = document.getElementById("contextRingValue");
  var contextPercent = document.getElementById("contextPercent");
  var contextSummary = document.getElementById("contextSummary");
  var contextProgress = document.getElementById("contextProgress");
  var contextBreakdown = document.getElementById("contextBreakdown");
  var btnCompact = document.getElementById("btnCompact");
  var compactionEl = document.getElementById("compaction");
  var compactionText = document.getElementById("compactionText");
  var slashPalette = document.getElementById("slashPalette");
  var filePalette = document.getElementById("filePalette");

  var bannerEl = document.getElementById("banner");
  var bannerIcon = document.getElementById("bannerIcon");
  var bannerMessage = document.getElementById("bannerMessage");
  var bannerDetails = document.getElementById("bannerDetails");
  var bannerDetailsWrap = document.getElementById("bannerDetailsWrap");
  var bannerActions = document.getElementById("bannerActions");
  var bannerDismiss = document.getElementById("bannerDismiss");

  if (
    !Markdown ||
    !StreamRender ||
    !headerEl ||
    !messagesEl ||
    !messagesContentEl ||
    !inputEl ||
    !composer ||
    !btnSend ||
    !btnModel ||
    !modelPopover ||
    !modelList ||
    !attachChips
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
    attachments: [],
    fileItems: [],
    fileIndex: 0,
    fileToken: 0,
    fileQuery: null,
    stopSentAt: 0,
  };

  var stream = {
    el: null,
    body: null,
    id: null,
    text: "",
    reasoning: null,
    tools: new Map(),
    answers: null,
    stableEl: null,
    openEl: null,
    capEl: null,
    capText: null,
    capNote: null,
    capButton: null,
    showFull: false,
    acc: null,
    scheduler: null,
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
      stableEl: null,
      openEl: null,
      capEl: null,
      capText: null,
      capNote: null,
      capButton: null,
      showFull: false,
      acc: null,
      scheduler: null,
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
      '<pre class="code-pre" dir="ltr"><code data-code="' +
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
    closeAllPopovers();
    modelPopover.hidden = false;
    btnModel.setAttribute("aria-expanded", "true");
    renderModelList();
    modelSearch.value = "";
    modelSearch.focus();
  }

  function closePopover() {
    modelPopover.hidden = true;
    btnModel.setAttribute("aria-expanded", "false");
  }

  btnModel.addEventListener("click", function () {
    if (modelPopover.hidden) openPopover();
    else closePopover();
  });

  modelSearch.addEventListener("input", renderModelList);

  modelPopover.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
      btnModel.focus();
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
    updateThinkingControl();
    closePopover();
  });

  document.addEventListener("click", function (event) {
    if (modelPopover.hidden) return;
    if (modelPopover.contains(event.target) || btnModel.contains(event.target)) return;
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
    if (entry && entry.description) btnAgent.title = entry.description;
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
    closeAllPopovers();
    renderAgentList();
    agentPopover.hidden = false;
    btnAgent.setAttribute("aria-expanded", "true");
    var first = agentList.querySelector(".model-item");
    if (first) first.focus();
  }

  function closeAgents() {
    agentPopover.hidden = true;
    btnAgent.setAttribute("aria-expanded", "false");
  }

  btnAgent.addEventListener("click", function () {
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

  function thinkingValue() {
    return (state.selectedModel && state.selectedModel.variant) || "";
  }

  function updateThinkingControl() {
    var variants = currentVariants();
    var has = variants.length > 0;
    btnThinking.hidden = !has;
    btnThinking.setAttribute("aria-hidden", String(!has));
    thinkingLabel.textContent = thinkingValue() || "auto";
  }

  function renderThinkingList(target) {
    if (!target) return;
    target.innerHTML = "";
    var variants = currentVariants();
    if (variants.length === 0) {
      target.appendChild(makeEl("div", "model-empty", "This model has no thinking levels"));
      return;
    }
    var ids = [""].concat(variants);
    ids.forEach(function (id) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "model-item";
      button.setAttribute("role", "option");
      button.dataset.thinking = id;
      button.setAttribute("aria-selected", String(thinkingValue() === id));
      button.appendChild(
        makeEl("span", "model-item-name", id ? id : "auto (model default)")
      );
      target.appendChild(button);
    });
  }

  function openThinking() {
    closeAllPopovers();
    renderThinkingList(thinkingList);
    thinkingPopover.hidden = false;
    btnThinking.setAttribute("aria-expanded", "true");
    var first = thinkingPopover.querySelector(".model-item");
    if (first) first.focus();
  }

  function closeThinking() {
    thinkingPopover.hidden = true;
    btnThinking.setAttribute("aria-expanded", "false");
  }

  btnThinking.addEventListener("click", function () {
    if (thinkingPopover.hidden) openThinking();
    else closeThinking();
  });

  function chooseThinking(id) {
    if (!state.selectedModel) return;
    state.selectedModel = {
      providerID: state.selectedModel.providerID,
      modelID: state.selectedModel.modelID,
      ...(id ? { variant: id } : {}),
    };
    updateThinkingControl();
    closeThinking();
    closeMore();
    post({
      type: "selectVariant",
      model: {
        providerID: state.selectedModel.providerID,
        modelID: state.selectedModel.modelID,
      },
      variant: id || undefined,
    });
  }

  function onThinkingClick(event) {
    var item = event.target.closest("[data-thinking]");
    if (!item) return;
    chooseThinking(item.dataset.thinking || "");
  }

  thinkingList.addEventListener("click", onThinkingClick);
  thinkingMoreList.addEventListener("click", onThinkingClick);

  function openMore() {
    closeAllPopovers();
    renderThinkingList(thinkingMoreList);
    morePopover.hidden = false;
    btnMore.setAttribute("aria-expanded", "true");
    var first = morePopover.querySelector(".model-item");
    if (first) first.focus();
  }

  function closeMore() {
    morePopover.hidden = true;
    btnMore.setAttribute("aria-expanded", "false");
  }

  btnMore.addEventListener("click", function () {
    if (morePopover.hidden) openMore();
    else closeMore();
  });

  function closeAllPopovers() {
    closePopover();
    closeAgents();
    closeThinking();
    closeMore();
    closeContext();
    closeSlash();
    closeFilePicker();
    closeSessions();
  }

  document.addEventListener("click", function (event) {
    if (!agentPopover.hidden) {
      if (!agentPopover.contains(event.target) && !btnAgent.contains(event.target)) closeAgents();
    }
    if (!sessionPanel.hidden) {
      if (!sessionPanel.contains(event.target) && !sessionButton.contains(event.target)) closeSessions();
    }
    if (!thinkingPopover.hidden) {
      if (!thinkingPopover.contains(event.target) && !btnThinking.contains(event.target)) closeThinking();
    }
    if (!morePopover.hidden) {
      if (!morePopover.contains(event.target) && !btnMore.contains(event.target)) closeMore();
    }
    if (!contextPopover.hidden) {
      if (!contextPopover.contains(event.target) && !btnContext.contains(event.target)) closeContext();
    }
    if (!filePalette.hidden) {
      if (!filePalette.contains(event.target) && !inputEl.contains(event.target)) closeFilePicker();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Context meter + compaction                                         */
  /* ------------------------------------------------------------------ */

  function renderContext(ctx) {
    state.context = ctx || state.context;
    var used = state.context.used || 0;
    var limit = state.context.limit || 0;
    var percent = Math.max(0, Math.min(100, state.context.percent || 0));
    contextRingValue.setAttribute("stroke-dashoffset", String(100 - percent));
    contextPercent.textContent = percent + "%";
    btnContext.classList.remove("warn", "danger");
    contextPopover.classList.remove("warn", "danger");
    if (percent >= 90) {
      btnContext.classList.add("danger");
      contextPopover.classList.add("danger");
    } else if (percent >= 70) {
      btnContext.classList.add("warn");
      contextPopover.classList.add("warn");
    }
    contextProgress.value = percent;
    contextSummary.textContent =
      formatTokens(used) + " / " + (limit ? formatTokens(limit) : "?") + " tokens (" + percent + "%)";
    var parts = [];
    if (state.context.breakdown) {
      var b = state.context.breakdown;
      parts.push("input " + b.input + " · cache read " + b.cache.read);
      parts.push("output " + b.output + " · reasoning " + b.reasoning);
      parts.push("cache write " + b.cache.write);
    }
    if (state.context.cost) parts.push("cost $" + Number(state.context.cost).toFixed(4));
    if (limit) parts.push("context limit " + limit);
    contextBreakdown.textContent = parts.join("\n");
    btnContext.title = parts.length
      ? "Context usage\n" + parts.join("\n")
      : "Context usage is estimated from the latest step (input + cache read).";
  }

  function openContext() {
    closeAllPopovers();
    contextPopover.hidden = false;
    btnContext.setAttribute("aria-expanded", "true");
    var focusable = contextPopover.querySelector("button");
    if (focusable) focusable.focus();
  }

  function closeContext() {
    contextPopover.hidden = true;
    btnContext.setAttribute("aria-expanded", "false");
  }

  btnContext.addEventListener("click", function () {
    if (contextPopover.hidden) openContext();
    else closeContext();
  });

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
    closeContext();
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
        messagesContentEl.innerHTML = "";
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

  var BANNER_ICONS = {
    error: "codicon-error",
    auth: "codicon-lock",
    warning: "codicon-warning",
    info: "codicon-info",
  };

  function renderBanner(banner) {
    if (!banner) {
      bannerEl.hidden = true;
      bannerActions.innerHTML = "";
      return;
    }
    bannerEl.hidden = false;
    bannerEl.className = "banner banner-" + (banner.kind || "info");
    bannerIcon.className = "banner-icon codicon " + (BANNER_ICONS[banner.kind] || "codicon-info");
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
    if (sendIcon) {
      sendIcon.className =
        "codicon " + (state.generating ? "codicon-debug-stop" : "codicon-send");
    }
    btnSend.classList.toggle("stop", state.generating);
    btnSend.setAttribute(
      "aria-label",
      state.generating ? "Stop generating" : "Send message"
    );
    btnSend.title = state.generating ? "Stop generating (Esc)" : "Send message";
    composer.classList.toggle("generating", state.generating);
    if (state.generating) {
      state.stopSentAt = 0;
    }
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

  /* Auto-follow: stick state is changed ONLY by the user's scroll (or an
     explicit pin when the user sends a prompt). Content growth merely asks
     for one scroll per animation frame while stuck. */
  var suppressScroll = false;
  var scrollFollow =
    UiState && UiState.createScrollFollow
      ? UiState.createScrollFollow({
          threshold: 24,
          requestFrame: function (callback) {
            window.requestAnimationFrame(callback);
          },
          scrollToBottom: function () {
            suppressScroll = true;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            suppressScroll = false;
            jumpLatest.hidden = true;
          },
          onStickChange: function () {
            updateJump();
          },
        })
      : null;

  function distanceFromBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  }

  function stickToBottom() {
    return scrollFollow ? scrollFollow.isStuck() : true;
  }

  function pinToBottom() {
    if (scrollFollow) scrollFollow.pin();
    else scrollToBottom();
  }

  function updateJump() {
    jumpLatest.hidden = stickToBottom() || messagesContentEl.children.length === 0;
  }

  function scrollToBottom(force) {
    if (force || !scrollFollow) pinToBottom();
    else if (scrollFollow.isStuck()) scrollFollow.onContentResize();
    if (!stickToBottom()) updateJump();
  }

  messagesEl.addEventListener("scroll", function () {
    if (suppressScroll) return;
    if (scrollFollow) scrollFollow.onUserScroll(distanceFromBottom());
    updateJump();
  });

  jumpLatest.addEventListener("click", function () {
    pinToBottom();
    updateJump();
  });

  if (typeof ResizeObserver === "function") {
    var messagesObserver = new ResizeObserver(function () {
      if (!scrollFollow) return;
      scrollFollow.onContentResize();
    });
    messagesObserver.observe(messagesContentEl);
  }

  function updateEmptyState() {
    var empty = messagesContentEl.children.length === 0;
    emptyStateEl.hidden = !empty;
    messagesEl.hidden = empty;
  }

  function createMessage(role, id, created) {
    var article = document.createElement("article");
    article.className = "msg msg-" + role;
    if (id) article.id = id;

    var meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.hidden = true;

    var body = document.createElement("div");
    body.className = "msg-body";
    body.dir = "auto";

    var time = document.createElement("time");
    time.className = "msg-time";
    time.dateTime = new Date(created || Date.now()).toISOString();
    time.textContent = formatTime(created);

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

  function attachmentIcon(att) {
    if (att.kind === "folder") return "codicon-folder";
    if (att.kind === "selection") return "codicon-selection";
    if (att.kind === "current") return "codicon-file";
    var mime = String(att.mime || "");
    if (mime.indexOf("image/") === 0) return "codicon-file-media";
    if (mime.indexOf("application/pdf") === 0) return "codicon-file-pdf";
    return "codicon-file-code";
  }

  function makeAttachmentChips(attachments, removable) {
    var wrap = document.createElement("div");
    wrap.className = "attachment-chips" + (removable ? " removable" : "");
    attachments.forEach(function (att) {
      var chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.title = att.uri || att.name || "";
      var icon = makeEl("span", "codicon " + attachmentIcon(att));
      icon.setAttribute("aria-hidden", "true");
      chip.appendChild(icon);
      var name = makeEl("span", "attachment-name", att.name || "file");
      name.dir = "auto";
      chip.appendChild(name);
      if (removable) {
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.dataset.removeAttachment = att.uri || att.name || "";
        remove.setAttribute("aria-label", "Remove " + (att.name || "attachment"));
        remove.title = "Remove attachment";
        var x = makeEl("span", "codicon codicon-close");
        x.setAttribute("aria-hidden", "true");
        remove.appendChild(x);
        chip.appendChild(remove);
      }
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function appendUserMessage(id, text, created, attachments) {
    var parts = createMessage("user", id, created);
    parts.body.innerHTML = renderMarkdown(text);
    var list = Array.isArray(attachments) ? attachments : [];
    if (list.length > 0) {
      parts.article.appendChild(makeAttachmentChips(list, false));
    }
    messagesContentEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(true);
  }

  function thinkingSummary(elapsedMs, done) {
    if (done) {
      return elapsedMs != null ? "Thought for " + formatDuration(elapsedMs) : "Thought";
    }
    return elapsedMs != null ? "Thinking · " + formatDuration(elapsedMs) : "Thinking…";
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
      case "read": return "codicon-eye";
      case "edit": return "codicon-edit";
      case "write": return "codicon-new-file";
      case "bash": return "codicon-terminal";
      case "search": return "codicon-search";
      case "web": return "codicon-globe";
      case "subagent": return "codicon-hubot";
      case "todo": return "codicon-checklist";
      default: return "codicon-tools";
    }
  }

  function toolVerb(kind) {
    switch (kind) {
      case "read": return "Read";
      case "edit": return "Edit";
      case "write": return "Write";
      case "bash": return "Run";
      case "search": return "Search";
      case "web": return "Fetch";
      case "subagent": return "Agent";
      case "todo": return "Todo";
      default: return "Tool";
    }
  }

  function statusGlyph(status) {
    switch (status) {
      case "done": return "codicon-check";
      case "failed": return "codicon-error";
      case "stopped": return "codicon-circle-slash";
      case "running":
      case "pending": return "codicon-loading codicon-modifier-spin";
      default: return "codicon-circle-outline";
    }
  }

  /** Middle-truncate long paths so the filename stays visible. */
  function middleTruncate(value, max) {
    var text = String(value || "");
    var limit = max || 64;
    if (text.length <= limit) return text;
    var keep = Math.floor((limit - 1) / 2);
    return text.slice(0, keep) + "…" + text.slice(text.length - (limit - keep - 1));
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
    card.dataset.kind = tool.kind || inferToolKind(tool.name);
    if (tool.name) card.title = tool.name;
    var head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    head.setAttribute("aria-expanded", "false");
    head.appendChild(
      makeEl("span", "tool-icon codicon " + toolIcon(tool.kind || inferToolKind(tool.name)))
    );
    head.appendChild(makeEl("span", "tool-verb", toolVerb(tool.kind || inferToolKind(tool.name))));
    var title = makeEl("span", "tool-title", tool.title || inferToolTitle(tool));
    title.setAttribute("title", tool.title || inferToolTitle(tool) || "");
    head.appendChild(title);
    var status = makeEl("span", "tool-status");
    head.appendChild(status);
    head.appendChild(
      makeEl("span", "tool-chevron codicon codicon-chevron-down")
    );
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
    var statusValue = tool.status || "pending";
    card.dataset.status = statusValue;
    card.dataset.kind = tool.kind || inferToolKind(tool.name);
    var status = card.querySelector(".tool-status");
    if (status) {
      status.className = "tool-status codicon " + statusGlyph(statusValue);
      status.setAttribute("aria-label", statusValue);
      status.title = statusValue;
    }
    var verb = card.querySelector(".tool-verb");
    if (verb) verb.textContent = toolVerb(tool.kind || inferToolKind(tool.name));
    var title = card.querySelector(".tool-title");
    if (title) {
      var full = tool.title || inferToolTitle(tool);
      title.textContent = middleTruncate(full, 72);
      title.setAttribute("title", full || "");
      title.dir = "ltr";
      title.classList.toggle("tool-title-path", /[\\/]/.test(full || ""));
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
      inputPre.dir = "ltr";
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
        open.dir = "ltr";
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
      outPre.dir = "ltr";
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

  /** Group 4+ terminal tool rows once the turn is no longer streaming. */
  function groupFinishedTools(container) {
    var list = container ? container.querySelector(".tool-list") : null;
    if (!list || list.dataset.grouped === "1") return;
    var cards = Array.prototype.slice.call(list.querySelectorAll(".tool-card"));
    var finished = cards.filter(function (card) {
      return card.dataset.status === "done" || card.dataset.status === "failed" || card.dataset.status === "stopped";
    });
    if (finished.length < 4) return;
    var details = document.createElement("details");
    details.className = "tool-group";
    var summary = document.createElement("summary");
    summary.className = "tool-group-summary";
    var doneCount = finished.filter(function (card) {
      return card.dataset.status === "done";
    }).length;
    summary.textContent =
      "Used " + finished.length + " tools" + (doneCount === finished.length ? "" : " · " + (finished.length - doneCount) + " issue(s)");
    details.appendChild(summary);
    var inner = makeEl("div", "tool-list tool-list-grouped");
    finished.forEach(function (card) {
      inner.appendChild(card);
    });
    details.appendChild(inner);
    list.appendChild(details);
    list.dataset.grouped = "1";
  }

  function ensureStreamParts() {
    if (!stream.body) return;
    if (stream.answers) return;
    stream.thinking = null;
    stream.toolList = makeEl("div", "tool-list");
    stream.answers = makeEl("div", "answer");
    stream.answers.dir = "auto";
    stream.stableEl = makeEl("div", "answer-stable");
    stream.openEl = makeEl("div", "answer-open");
    var files = makeEl("div", "files-summary");
    files.hidden = true;
    stream.body.innerHTML = "";
    stream.body.appendChild(stream.toolList);
    stream.answers.appendChild(stream.stableEl);
    stream.answers.appendChild(stream.openEl);
    stream.body.appendChild(stream.answers);
    stream.body.appendChild(files);
    showTyping();
  }

  function showTyping() {
    if (!stream.openEl) return;
    stream.openEl.innerHTML =
      '<div class="typing" role="status" aria-label="OpenCode is typing">' +
      "<span></span><span></span><span></span></div>";
  }

  function startAssistant(id, agent, model) {
    if (stream.el) endAssistant();
    var stick = stickToBottom();
    var parts = createMessage("assistant", id, Date.now());
    parts.article.classList.add("streaming");
    updateMessageMeta(parts.meta, agent, model);
    messagesContentEl.appendChild(parts.article);
    resetStream();
    stream = {
      el: parts.article,
      body: parts.body,
      id: id,
      text: "",
      reasoning: null,
      tools: new Map(),
      answers: null,
      stableEl: null,
      openEl: null,
      capEl: null,
      capText: null,
      capNote: null,
      capButton: null,
      showFull: false,
      acc: StreamRender.createAccumulator(),
      scheduler: StreamRender.createRenderScheduler({
        flush: flushStreamRender,
        requestFrame: window.requestAnimationFrame.bind(window),
      }),
      thinking: null,
      toolList: null,
      files: new Map(),
      meta: parts.meta,
    };
    ensureStreamParts();
    updateEmptyState();
    scrollToBottom(stick);
  }

  /** Clear the two answer containers and any capped view. */
  function resetAnswerDom() {
    if (stream.stableEl) stream.stableEl.innerHTML = "";
    if (stream.openEl) stream.openEl.innerHTML = "";
    if (stream.capEl && stream.capEl.parentNode) stream.capEl.parentNode.removeChild(stream.capEl);
    stream.capEl = null;
    stream.capText = null;
    stream.capNote = null;
    stream.capButton = null;
    stream.showFull = false;
    if (stream.answers) stream.answers.classList.remove("capped");
  }

  function scheduleStreamRender() {
    if (stream.scheduler) stream.scheduler.schedule();
  }

  /** Enter the plain-text mode used above ~200k characters. */
  function enterCappedMode(snapshot) {
    if (!stream.answers) return;
    resetAnswerDom();
    stream.answers.classList.add("capped");
    var wrap = makeEl("div", "stream-cap");
    var note = makeEl("div", "stream-cap-note", "");
    var pre = document.createElement("pre");
    pre.className = "stream-cap-text";
    pre.dir = "auto";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "banner-btn";
    button.dataset.streamFull = "1";
    wrap.dataset.full = "0";
    wrap._fullText = snapshot.text;
    wrap._tailText = snapshot.tail;
    wrap._total = snapshot.length;
    wrap.appendChild(note);
    wrap.appendChild(pre);
    wrap.appendChild(button);
    stream.answers.appendChild(wrap);
    stream.capEl = wrap;
    stream.capText = pre;
    stream.capNote = note;
    stream.capButton = button;
    stream.showFull = false;
    updateCappedView(snapshot);
  }

  /** Refresh one capped view from the data stored on its DOM node. */
  function applyCapContent(cap) {
    if (!cap) return;
    var pre = cap.querySelector(".stream-cap-text");
    var button = cap.querySelector("[data-stream-full]");
    var full = cap.dataset.full === "1";
    if (pre) pre.textContent = full ? cap._fullText || "" : cap._tailText || "";
    if (button) {
      button.textContent = full ? "Show tail only" : "Show full output";
      button.setAttribute("aria-pressed", full ? "true" : "false");
    }
  }

  function updateCappedView(snapshot) {
    if (!stream.capEl || !stream.acc) return;
    var snap = snapshot || stream.acc.snapshot();
    if (!snap || !snap.capped) return;
    stream.capEl._fullText = snap.text;
    stream.capEl._tailText = snap.tail;
    stream.capEl._total = snap.length;
    if (stream.capNote) {
      stream.capNote.textContent =
        "Output is very long (" +
        snap.length.toLocaleString() +
        " characters). Live formatting is paused to keep the chat responsive.";
    }
    applyCapContent(stream.capEl);
  }

  function toggleFullOutput(button) {
    var cap = button ? button.closest(".stream-cap") : null;
    if (!cap) return;
    cap.dataset.full = cap.dataset.full === "1" ? "0" : "1";
    applyCapContent(cap);
    scrollToBottom(true);
  }

  /**
   * One coalesced render per animation frame:
   *  - completed blocks are appended once,
   *  - only the open tail is re-parsed,
   *  - above the cap we only refresh the tail text.
   */
  function flushStreamRender(force) {
    if (!stream.el || !stream.answers || !stream.acc) return;
    var stick = stickToBottom();

    if (stream.capEl) {
      updateCappedView();
      scrollToBottom(stick);
      return;
    }

    var snap = stream.acc.snapshot();
    if (snap.capped) {
      enterCappedMode(snap);
      stream.acc.commit(snap);
      scrollToBottom(stick);
      return;
    }
    if (snap.reset) resetAnswerDom();
    if (snap.stableDelta && stream.stableEl) {
      stream.stableEl.insertAdjacentHTML("beforeend", renderMarkdown(snap.stableDelta));
    }
    if ((snap.stableDelta || snap.openChanged || force) && stream.openEl) {
      stream.openEl.innerHTML = renderMarkdown(snap.open);
    }
    stream.acc.commit(snap);
    scrollToBottom(stick);
  }

  /** Final render on end: one full Markdown pass (or the capped plain view). */
  function finishStreamRender() {
    if (!stream.el || !stream.acc) return;
    var stick = stickToBottom();
    var snap = stream.acc.snapshot();
    if (snap.capped) {
      if (!stream.capEl) enterCappedMode(snap);
      else updateCappedView(snap);
      stream.acc.commit(snap);
      scrollToBottom(stick);
      return;
    }
    if (stream.stableEl) stream.stableEl.innerHTML = "";
    if (stream.openEl) stream.openEl.innerHTML = renderMarkdown(stream.text);
    stream.acc.commit(snap);
    scrollToBottom(stick);
  }

  function markIncomplete(article, reason) {
    if (!article || article.querySelector(".msg-badge.incomplete")) return;
    article.classList.add("incomplete");
    var badge = makeEl("span", "msg-badge incomplete", "incomplete");
    if (reason) badge.title = reason;
    article.appendChild(badge);
    var actions = makeEl("div", "msg-actions");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "banner-btn primary";
    button.textContent = "Continue";
    button.dataset.continue = "1";
    if (reason) button.title = reason;
    actions.appendChild(button);
    article.appendChild(actions);
  }

  function markStopped(article) {
    if (!article || article.querySelector(".msg-badge.stopped")) return;
    article.classList.add("stopped");
    article.appendChild(makeEl("span", "msg-badge stopped", "Stopped"));
    updateJump();
  }

  function applyAssistantDelta(id, message) {
    message = message || {};
    if (!stream.el || stream.id !== id) startAssistant(id);
    if (!stream.el || !stream.acc) return;
    var stick = stickToBottom();
    var full = typeof message.text === "string" ? message.text : "";

    if (message.resync) {
      stream.text = full;
      stream.acc.resync(full);
      resetAnswerDom();
    } else if (typeof message.delta === "string" && message.delta) {
      stream.text += message.delta;
      stream.acc.append(message.delta);
    } else if (full && full !== stream.text) {
      // Backward-compatible full-text snapshot.
      stream.text = full;
      stream.acc.resync(full);
      resetAnswerDom();
    } else {
      return;
    }

    if (stream.reasoning && stream.reasoning.details.open && stream.text.trim()) {
      stream.reasoning.details.open = false;
    }
    scheduleStreamRender();
    scrollToBottom(stick);
  }

  function endAssistant(id, message) {
    if (!stream.el) return;
    if (id && stream.id !== id) return;
    finishStreamRender();
    var article = stream.el;
    groupFinishedTools(article);
    if (message && message.stopped) markStopped(article);
    else if (message && message.incomplete) markIncomplete(article, message.reason);
    article.classList.remove("streaming");
    updateJump();
    resetStream();
  }

  function renderHistoryMessage(message) {
    if (message.role !== "assistant") {
      appendUserMessage(
        message.id,
        message.text || "",
        message.created,
        message.attachments || []
      );
      return;
    }
    var stick = stickToBottom();
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
      if (toolList) groupFinishedTools(body);
    }
    if (Array.isArray(message.files) && message.files.length > 0) {
      body.appendChild(makeFilesSummary(message.files));
    }
    messagesContentEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(stick);
  }

  function renderHistory(history) {
    messagesContentEl.innerHTML = "";
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
    var stick = stickToBottom();
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
    messagesContentEl.appendChild(article);
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
    messagesContentEl.appendChild(article);
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
    messagesContentEl.appendChild(article);
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

    var continueButton = event.target.closest("[data-continue]");
    if (continueButton) {
      continueButton.disabled = true;
      post({ type: "continue" });
      return;
    }

    var streamFull = event.target.closest("[data-stream-full]");
    if (streamFull) {
      toggleFullOutput(streamFull);
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
    var maxHeight = lineHeight * 8 + 10;
    var next = Math.min(inputEl.scrollHeight, maxHeight);
    inputEl.style.height = next + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function updateToolbarLayout() {
    var width = composer.clientWidth || window.innerWidth;
    var mode =
      UiState && UiState.toolbarMode
        ? UiState.toolbarMode(width)
        : { compact: width < 340, tiny: width < 260 };
    composer.classList.toggle("compact", mode.compact);
    composer.classList.toggle("tiny", mode.tiny);
    btnMore.hidden = !mode.tiny || currentVariants().length === 0;
    if (!mode.tiny) closeMore();
  }

  if (typeof ResizeObserver === "function") {
    var composerObserver = new ResizeObserver(updateToolbarLayout);
    composerObserver.observe(composer);
  }
  window.addEventListener("resize", updateToolbarLayout);

  /* Attachments ------------------------------------------------------- */

  function dedupeAttachments(list) {
    if (UiState && UiState.dedupeAttachments) {
      return UiState.dedupeAttachments(list, []);
    }
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (att) {
      if (!att || !att.uri || typeof att.uri !== "string") return;
      if (seen[att.uri]) return;
      seen[att.uri] = true;
      out.push(att);
    });
    return out;
  }

  function renderAttachChips() {
    attachChips.innerHTML = "";
    if (state.attachments.length === 0) {
      attachChips.hidden = true;
      return;
    }
    attachChips.hidden = false;
    attachChips.appendChild(makeAttachmentChips(state.attachments, true));
  }

  function addAttachments(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    state.attachments = dedupeAttachments(state.attachments.concat(list));
    renderAttachChips();
    inputEl.focus();
  }

  function removeAttachment(uri) {
    state.attachments = state.attachments.filter(function (att) {
      return att.uri !== uri;
    });
    renderAttachChips();
    inputEl.focus();
  }

  var noteTimer = null;
  function showComposerNote(text, kind) {
    if (!text) {
      composerNote.hidden = true;
      return;
    }
    composerNote.hidden = false;
    composerNote.className = "composer-note " + (kind || "info");
    composerNote.textContent = text;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(function () {
      composerNote.hidden = true;
    }, 7000);
  }

  attachChips.addEventListener("click", function (event) {
    var remove = event.target.closest("[data-remove-attachment]");
    if (!remove) return;
    removeAttachment(remove.dataset.removeAttachment);
  });

  btnAttach.addEventListener("click", function () {
    post({ type: "files:pick", mode: "quick" });
  });

  /* @ file picker ----------------------------------------------------- */

  function currentAtQuery() {
    var value = inputEl.value || "";
    var caret =
      typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : value.length;
    var before = value.slice(0, caret);
    var match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return null;
    return {
      query: match[1],
      start: caret - match[1].length - 1,
      end: caret,
    };
  }

  function closeFilePicker() {
    filePalette.hidden = true;
    state.fileItems = [];
    state.fileIndex = 0;
    state.fileQuery = null;
  }

  function filePickerOpen() {
    return !filePalette.hidden;
  }

  function renderFileItems(items) {
    state.fileItems = Array.isArray(items) ? items : [];
    state.fileIndex = 0;
    filePalette.innerHTML = "";
    if (state.fileItems.length === 0) {
      filePalette.appendChild(makeEl("div", "model-empty", "No matching workspace files"));
      filePalette.hidden = false;
      return;
    }
    state.fileItems.forEach(function (item, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "slash-item file-item" + (index === 0 ? " active" : "");
      button.dataset.fileIndex = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === 0));
      var icon = makeEl("span", "codicon codicon-file file-item-icon");
      icon.setAttribute("aria-hidden", "true");
      button.appendChild(icon);
      var name = makeEl("span", "file-item-name", item.name || "file");
      name.dir = "ltr";
      button.appendChild(name);
      var path = makeEl("span", "file-item-path", item.path || "");
      path.dir = "ltr";
      button.appendChild(path);
      filePalette.appendChild(button);
    });
    filePalette.hidden = false;
  }

  var fileTimer = null;
  function requestFileList(query) {
    state.fileToken += 1;
    var token = state.fileToken;
    window.clearTimeout(fileTimer);
    fileTimer = window.setTimeout(function () {
      post({ type: "files:list", query: query, requestID: String(token) });
    }, 120);
  }

  function updateFilePicker() {
    var at = currentAtQuery();
    if (!at) {
      closeFilePicker();
      return;
    }
    requestFileList(at.query);
    state.fileQuery = {
      token: state.fileToken,
      query: at.query,
      start: at.start,
      end: at.end,
    };
  }

  function chooseFile(index) {
    var item = state.fileItems[index];
    if (!item) return;
    addAttachments([
      {
        uri: item.uri,
        name: item.name,
        kind: item.kind || "file",
        ...(item.size ? { size: item.size } : {}),
      },
    ]);
    var at = state.fileQuery;
    if (at && typeof at.start === "number") {
      var value = inputEl.value || "";
      inputEl.value = value.slice(0, at.start) + value.slice(at.end);
      var caret = at.start;
      try {
        inputEl.setSelectionRange(caret, caret);
      } catch (_err) {
        /* ignore */
      }
    }
    closeFilePicker();
    resizeTextarea();
  }

  filePalette.addEventListener("click", function (event) {
    var item = event.target.closest("[data-file-index]");
    if (!item) return;
    chooseFile(Number(item.dataset.fileIndex));
  });

  /* Drag and drop ----------------------------------------------------- */

  function dropUris(dataTransfer) {
    if (!dataTransfer) return [];
    var found = [];
    var types = ["text/uri-list", "application/vnd.code.uri-list", "application/vnd.code.resourceurls", "text/plain"];
    types.forEach(function (type) {
      var value = "";
      try {
        value = dataTransfer.getData(type) || "";
      } catch (_err) {
        value = "";
      }
      if (!value) return;
      var candidates = value.split(/\r?\n/).filter(function (line) {
        return line && line.charAt(0) !== "#";
      });
      if (candidates.length === 1 && candidates[0].charAt(0) === "[") {
        try {
          var parsed = JSON.parse(candidates[0]);
          if (Array.isArray(parsed)) {
            candidates = parsed.map(function (entry) {
              if (typeof entry === "string") return entry;
              return entry && (entry.uri || entry.fsPath || entry.external) ? entry.uri || entry.fsPath || entry.external : "";
            });
          }
        } catch (_err) {
          /* keep the raw value */
        }
      }
      candidates.forEach(function (line) {
        var uri = line.trim();
        if (uri && found.indexOf(uri) === -1) found.push(uri);
      });
    });
    return found;
  }

  function dragHasFiles(event) {
    var dt = event.dataTransfer;
    if (!dt) return false;
    var types = Array.prototype.slice.call(dt.types || []);
    return (
      types.indexOf("Files") !== -1 ||
      types.indexOf("text/uri-list") !== -1 ||
      types.indexOf("application/vnd.code.uri-list") !== -1 ||
      types.indexOf("application/vnd.code.resourceurls") !== -1
    );
  }

  composerCard.addEventListener("dragover", function (event) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    composerCard.classList.add("drag-over");
  });
  composerCard.addEventListener("dragleave", function (event) {
    if (event.target === composerCard) composerCard.classList.remove("drag-over");
  });
  composerCard.addEventListener("drop", function (event) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    composerCard.classList.remove("drag-over");
    var uris = dropUris(event.dataTransfer);
    if (uris.length > 0) post({ type: "files:drop", uris: uris });
  });

  /* Sending ----------------------------------------------------------- */

  function send() {
    var text = inputEl.value.trim();
    if (state.generating) {
      stopGeneration();
      return;
    }
    if (!text && state.attachments.length === 0) return;
    var attachments = state.attachments.slice();
    inputEl.value = "";
    state.attachments = [];
    renderAttachChips();
    showComposerNote("", "info");
    resizeTextarea();
    closeSlash();
    closeFilePicker();
    pinToBottom();
    scrollToBottom(true);
    post({
      type: "send",
      text: text,
      ...(attachments.length > 0 ? { attachments: attachments } : {}),
    });
  }

  function stopGeneration() {
    if (!state.generating) return;
    if (Date.now() - state.stopSentAt < 500) return;
    state.stopSentAt = Date.now();
    post({ type: "stop" });
  }

  inputEl.addEventListener("input", function () {
    resizeTextarea();
    state.slashIndex = 0;
    renderSlash();
    updateFilePicker();
  });
  inputEl.addEventListener("keydown", function (event) {
    if (filePickerOpen()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (state.fileItems.length > 0) {
          var delta = event.key === "ArrowDown" ? 1 : -1;
          state.fileIndex =
            (state.fileIndex + delta + state.fileItems.length) % state.fileItems.length;
          var items = filePalette.querySelectorAll("[data-file-index]");
          for (var fi = 0; fi < items.length; fi += 1) {
            var active = fi === state.fileIndex;
            items[fi].classList.toggle("active", active);
            items[fi].setAttribute("aria-selected", String(active));
            if (active) items[fi].scrollIntoView({ block: "nearest" });
          }
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseFile(state.fileIndex);
        return;
      }
    }
    if (!slashPalette.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (state.slashItems.length > 0) {
          var sdelta = event.key === "ArrowDown" ? 1 : -1;
          state.slashIndex =
            (state.slashIndex + sdelta + state.slashItems.length) % state.slashItems.length;
          renderSlash();
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseSlash(state.slashIndex);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || event.isComposing) return;
    var overlayOpen =
      !modelPopover.hidden ||
      !agentPopover.hidden ||
      !thinkingPopover.hidden ||
      !morePopover.hidden ||
      !contextPopover.hidden ||
      !sessionPanel.hidden ||
      !slashPalette.hidden ||
      filePickerOpen();
    var action =
      UiState && UiState.escapeAction
        ? UiState.escapeAction({ overlayOpen: overlayOpen, generating: state.generating })
        : overlayOpen
          ? "close-overlay"
          : state.generating
            ? "stop"
            : "none";
    if (action === "close-overlay") {
      event.preventDefault();
      event.stopPropagation();
      closeAllPopovers();
      inputEl.focus();
      return;
    }
    if (action === "stop") {
      event.preventDefault();
      stopGeneration();
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
    if (state.generating) stopGeneration();
    else send();
  });

  btnCancelWait.addEventListener("click", function () {
    stopGeneration();
  });

  btnNewChat.addEventListener("click", function () {
    messagesContentEl.innerHTML = "";
    updateEmptyState();
    setStatus("idle", "", false, false);
    renderBanner(null);
    closeAllPopovers();
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
        updateThinkingControl();
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
        state.attachments = [];
        renderAttachChips();
        updateToolbarLayout();
        break;
      }
      case "model-selected": {
        state.selectedModel = message.selectedModel || null;
        updateModelLabel();
        updateThinkingControl();
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
        updateThinkingControl();
        updateSessionLabel();
        state.attachments = [];
        renderAttachChips();
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
        // Append the delta; never re-assign the whole reasoning string.
        if (typeof message.delta === "string" && message.delta) {
          stream.reasoning.text.appendChild(document.createTextNode(message.delta));
        } else if (typeof message.text === "string" && message.text) {
          stream.reasoning.text.textContent = message.text;
        }
        break;
      }
      case "reasoning-end": {
        if (stream.reasoning) {
          if (typeof message.text === "string" && message.text !== stream.reasoning.text.textContent) {
            stream.reasoning.text.textContent = message.text;
          }
          stream.reasoning.summary.textContent = thinkingSummary(message.elapsedMs, true);
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
        appendUserMessage(
          message.id,
          message.text || "",
          message.created,
          message.attachments || []
        );
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
        applyAssistantDelta(message.messageID, message);
        break;
      }
      case "assistant-end": {
        endAssistant(message.messageID, message);
        break;
      }
      case "open-model-picker": {
        if (modelPopover.hidden) openPopover();
        break;
      }
      case "banner": {
        renderBanner(message.banner || null);
        break;
      }
      case "files:list": {
        var requestID = String(message.requestID || "");
        if (
          !state.fileQuery ||
          String(state.fileQuery.token) !== requestID ||
          String(state.fileToken) !== requestID
        ) {
          break;
        }
        renderFileItems(message.items || []);
        break;
      }
      case "files:add": {
        addAttachments(message.attachments || []);
        var warnings = Array.isArray(message.warnings) ? message.warnings : [];
        var errors = Array.isArray(message.errors) ? message.errors : [];
        if (errors.length > 0) {
          showComposerNote(errors.join(" "), "error");
        } else if (warnings.length > 0) {
          showComposerNote(warnings.join(" "), "warning");
        }
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
