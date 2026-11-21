/**
 * OpenCode Bridge - webview frontend (chat UI).
 *
 * Communicates with the extension via window.postMessage / message event.
 * Renders messages, streams assistant replies, handles input (Enter=send,
 * Shift+Enter=newline), renders Markdown (code blocks get a Copy button),
 * and follows the strict CSP delivered by the extension (nonce-based, no
 * inline handlers).
 */

(function () {
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnNewChat = document.getElementById("btnNewChat");
  const btnRetry = document.getElementById("btnRetry");
  const statusEl = document.getElementById("status");
  const modelSelect = document.getElementById("modelSelect");
  const serverInfo = document.getElementById("serverInfo");
  const composer = document.getElementById("composer");

  if (!messagesEl || !inputEl || !btnSend || !composer || !modelSelect) {
    console.error("OpenCode Bridge: required DOM elements missing");
    return;
  }

  let currentSessionID = null;
  let streamingMessageEl = null;
  let streamingText = "";
  let availableModels = []; // { id, label, providerID, modelID }

  /* ---------- Escape HTML ---------- */
  function escapeHtml(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeHtmlAttr(text) {
    return String(text)
      .replace(/"/g, "&quot;")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ---------- Minimal Markdown renderer ---------- */
  function renderMarkdown(text) {
    if (typeof text !== "string") text = "";
    const parts = text.split(/```([\s\S]*?)```/g);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 4 === 1) continue; // language group
      if (i % 4 === 2) {
        const lang = (parts[i - 1] || "").trim();
        const code = part;
        html += renderCodeBlock(lang, code);
        continue;
      }
      html += renderInline(part);
    }
    return html;
  }

  function renderCodeBlock(lang, code) {
    const safeLang = escapeHtml(lang);
    const safeCode = escapeHtml(code);
    return `
<div class="code-block">
  <div class="code-header">
    <span class="code-lang">${safeLang || "text"}</span>
    <button class="copy-btn" data-code="${escapeHtmlAttr(safeCode)}" title="Copy code">Copy</button>
  </div>
  <pre><code class="lang-${safeLang}">${safeCode}</code></pre>
</div>`;
  }

  function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    out = out.replace(/\n/g, "<br>");
    return out;
  }

  /* ---------- Model dropdown ---------- */
  function renderModelDropdown() {
    modelSelect.innerHTML = "";
    // Default option
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Default model (server default)";
    modelSelect.appendChild(defaultOpt);
    for (const m of availableModels) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ providerID: m.providerID, modelID: m.modelID });
      opt.textContent = `${m.label} (${m.providerID})`;
      modelSelect.appendChild(opt);
    }
    modelSelect.disabled = availableModels.length === 0;
  }

  modelSelect.addEventListener("change", () => {
    const val = modelSelect.value;
    if (!val) {
      window.parent.postMessage({ type: "selectModel", model: null }, "*");
      return;
    }
    try {
      const model = JSON.parse(val);
      window.parent.postMessage({ type: "selectModel", model }, "*");
    } catch (e) {
      console.error("OpenCode Bridge: invalid model value", val);
    }
  });

  /* ---------- Messages ---------- */
  function appendUserMessage(id, text) {
    const div = document.createElement("div");
    div.className = "message user";
    div.id = id;
    div.innerHTML = `<div class="bubble">${renderMarkdown(text)}</div><div class="meta">you</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function startAssistantMessage(messageID, sessionID) {
    streamingMessageEl = document.createElement("div");
    streamingMessageEl.className = "message assistant streaming";
    streamingMessageEl.id = messageID;
    streamingMessageEl.innerHTML = `<div class="bubble"></div><div class="meta">OpenCode <span class="pulse">●</span></div>`;
    messagesEl.appendChild(streamingMessageEl);
    streamingText = "";
    scrollToBottom();
    return streamingMessageEl.querySelector(".bubble");
  }

  function updateAssistantMessage(messageID, delta, fullText) {
    if (!streamingMessageEl || streamingMessageEl.id !== messageID) {
      startAssistantMessage(messageID, null);
    }
    const bubble = streamingMessageEl.querySelector(".bubble");
    streamingText = fullText;
    bubble.innerHTML = renderMarkdown(streamingText);
    streamingMessageEl.classList.remove("streaming");
    attachCopyHandlers();
    scrollToBottom();
  }

  function endAssistantMessage(messageID) {
    if (streamingMessageEl && streamingMessageEl.id === messageID) {
      streamingMessageEl.classList.remove("streaming");
      attachCopyHandlers();
    }
    streamingMessageEl = null;
    streamingText = "";
    setStatus("idle");
    showRetry(false);
  }

  function clearMessages() {
    messagesEl.innerHTML = "";
    streamingMessageEl = null;
    streamingText = "";
  }

  function attachCopyHandlers() {
    document.querySelectorAll(".copy-btn").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", (ev) => {
        const code = btn.getAttribute("data-code") || "";
        navigator.clipboard
          .writeText(code)
          .then(() => {
            const old = btn.textContent;
            btn.textContent = "Copied!";
            setTimeout(() => (btn.textContent = old), 1200);
          })
          .catch(() => {
            btn.textContent = "Failed";
            setTimeout(() => (btn.textContent = "Copy"), 1200);
          });
      });
    });
  }

  /* ---------- Status / error ---------- */
  function setStatus(status, message) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = "status " + (status || "idle");
    statusEl.hidden = !message && status === "idle";
  }

  function showRetry(show) {
    if (!btnRetry) return;
    btnRetry.style.display = show ? "inline-block" : "none";
  }

  /* ---------- Scroll ---------- */
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  /* ---------- Input handling ---------- */
  function resizeTextarea() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }

  inputEl.addEventListener("input", resizeTextarea);
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  btnSend.addEventListener("click", (ev) => {
    ev.preventDefault();
    send();
  });

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    resizeTextarea();
    window.parent.postMessage({ type: "send", text }, "*");
  }

  btnNewChat.addEventListener("click", () => {
    currentSessionID = null;
    clearMessages();
    setStatus("idle");
    showRetry(false);
    window.parent.postMessage({ type: "newChat" }, "*");
  });

  btnRetry.addEventListener("click", () => {
    showRetry(false);
    setStatus("idle");
    window.parent.postMessage({ type: "retry" }, "*");
  });

  /* ---------- Messages from extension ---------- */
  window.addEventListener("message", (ev) => {
    const msg = ev.data || {};
    switch (msg.type) {
      case "init":
        currentSessionID = msg.sessionID ?? null;
        availableModels = msg.models || [];
        renderModelDropdown();
        // Show server URL and working directory in the header tooltip.
        if (serverInfo) {
          const parts = [];
          if (msg.serverUrl) parts.push(`Server: ${msg.serverUrl}`);
          if (msg.workspaceDir) parts.push(`Workspace: ${msg.workspaceDir}`);
          serverInfo.textContent = parts.join("  |  ");
          serverInfo.title = parts.join("\n");
          serverInfo.style.display = parts.length ? "inline-block" : "none";
        }
        // If there was a provider/model load error, show it as an error bubble.
        if (msg.providersError) {
          const errDiv = document.createElement("div");
          errDiv.className = "message system-error";
          errDiv.innerHTML = `<div class="bubble error-bubble">⚠ Failed to load models/providers: ${escapeHtml(msg.providersError)}</div>`;
          messagesEl.appendChild(errDiv);
          scrollToBottom();
        }
        if (msg.selectedModel) {
          // Select matching option
          for (let i = 0; i < modelSelect.options.length; i++) {
            const opt = modelSelect.options[i];
            if (opt.value && opt.value !== "") {
              try {
                const m = JSON.parse(opt.value);
                if (m.providerID === msg.selectedModel.providerID && m.modelID === msg.selectedModel.modelID) {
                  modelSelect.selectedIndex = i;
                  break;
                }
              } catch { /* ignore */ }
            }
          }
        }
        break;
      case "status":
        setStatus(msg.status, msg.message);
        if (msg.status === "error") showRetry(true);
        else if (msg.status === "idle") showRetry(false);
        break;
      case "user-message":
        appendUserMessage(msg.id, msg.text);
        break;
      case "assistant-start":
        startAssistantMessage(msg.messageID, msg.sessionID);
        setStatus("thinking", msg.message || "OpenCode is thinking…");
        break;
      case "assistant-delta":
        updateAssistantMessage(msg.messageID, msg.delta, msg.text);
        break;
      case "assistant-end":
        endAssistantMessage(msg.messageID);
        break;
      case "error":
        setStatus("error", msg.message);
        showRetry(true);
        // Also append an error message bubble to the chat
        const errDiv = document.createElement("div");
        errDiv.className = "message system-error";
        errDiv.innerHTML = `<div class="bubble error-bubble">⚠ ${escapeHtml(msg.message)}</div>`;
        if (msg.details) {
          errDiv.innerHTML += `<details><summary>Details</summary><pre>${escapeHtml(msg.details)}</pre></details>`;
        }
        messagesEl.appendChild(errDiv);
        scrollToBottom();
        break;
      case "retry":
        showRetry(false);
        break;
      case "providers":
        availableModels = (msg.providers || []).map(p => ({
          id: p.modelID || p.id,
          label: p.name || p.id,
          providerID: p.providerID || p.id,
          modelID: p.modelID || p.id,
        }));
        renderModelDropdown();
        break;
      case "no-providers":
        modelSelect.innerHTML = "";
        const noOpt = document.createElement("option");
        noOpt.value = "";
        noOpt.textContent = "No providers configured";
        noOpt.disabled = true;
        modelSelect.appendChild(noOpt);
        modelSelect.disabled = true;
        // Show an info bubble with raw error details if available.
        const infoDiv = document.createElement("div");
        infoDiv.className = "message system-error";
        infoDiv.innerHTML = `<div class="bubble error-bubble">⚠ No model providers are connected to OpenCode. Open OpenCode and run <code>/connect</code> to add a provider (e.g. Anthropic, OpenAI), then refresh this view.</div>`;
        if (msg.providersError) {
          infoDiv.innerHTML += `<details><summary>Details</summary><pre>${escapeHtml(msg.providersError)}</pre></details>`;
        }
        messagesEl.appendChild(infoDiv);
        scrollToBottom();
        break;
      default:
        console.warn("[opencode-bridge webview] unknown message", msg.type);
    }
  });

  // Tell the extension the view is ready (optional handshake).
  window.parent.postMessage({ type: "ready" }, "*");
})();
