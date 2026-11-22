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
    mode: "managed",
    serverUrl: "",
    workspaceDir: "",
    generating: false,
  };

  var stream = { el: null, body: null, id: null, text: "" };
  var codeSeq = 0;
  var codeStore = new Map();

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

    var body = document.createElement("div");
    body.className = "msg-body";
    body.dir = "auto";

    var time = document.createElement("time");
    time.className = "msg-time";
    time.dateTime = new Date(created || Date.now()).toISOString();
    time.textContent = formatTime(created);

    article.appendChild(roleEl);
    article.appendChild(body);
    article.appendChild(time);
    return { article: article, body: body, time: time };
  }

  function appendUserMessage(id, text, created) {
    var parts = createMessage("user", id, created);
    parts.body.innerHTML = renderMarkdown(text);
    messagesEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(true);
  }

  function appendAssistantMessage(id, text, created) {
    var stick = isNearBottom();
    var parts = createMessage("assistant", id, created);
    parts.body.innerHTML = renderMarkdown(text);
    messagesEl.appendChild(parts.article);
    updateEmptyState();
    scrollToBottom(stick);
  }

  function startAssistant(id) {
    if (stream.el) endAssistant();
    var stick = isNearBottom();
    var parts = createMessage("assistant", id, Date.now());
    parts.article.classList.add("streaming");
    parts.body.innerHTML =
      '<div class="typing" role="status" aria-label="OpenCode is typing">' +
      "<span></span><span></span><span></span></div>";
    messagesEl.appendChild(parts.article);
    stream = { el: parts.article, body: parts.body, id: id, text: "" };
    updateEmptyState();
    scrollToBottom(stick);
  }

  function updateAssistant(id, fullText) {
    if (!stream.el || stream.id !== id) startAssistant(id);
    if (!stream.el) return;
    var stick = isNearBottom();
    stream.text = fullText || "";
    stream.body.innerHTML = renderMarkdown(stream.text);
    stream.el.classList.remove("streaming");
    scrollToBottom(stick);
  }

  function endAssistant(id) {
    if (!stream.el) return;
    if (id && stream.id !== id) return;
    stream.el.classList.remove("streaming");
    stream.el = null;
    stream.body = null;
    stream.id = null;
    stream.text = "";
  }

  function renderHistory(history) {
    messagesEl.innerHTML = "";
    stream = { el: null, body: null, id: null, text: "" };
    codeStore.clear();
    (history || []).forEach(function (message) {
      if (message.role === "assistant") {
        appendAssistantMessage(message.id, message.text || "", message.created);
      } else {
        appendUserMessage(message.id, message.text || "", message.created);
      }
    });
    updateEmptyState();
    scrollToBottom(true);
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

  inputEl.addEventListener("input", resizeTextarea);
  inputEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
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
        state.mode = message.mode || "managed";
        updateHeaderInfo(message);
        updateModelLabel();
        if (!modelPopover.hidden) renderModelList();
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
        if (!modelPopover.hidden) renderModelList();
        closePopover();
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
        startAssistant(message.messageID);
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
