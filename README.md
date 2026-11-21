# OpenCode Bridge

A VS Code / VSCodium chat client for [OpenCode](https://opencode.ai) (opencode.ai).

The extension does **not** call any LLM API itself. It connects to a local
OpenCode HTTP server (`opencode serve`), which already holds the model and API
key configuration, and uses the official [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk)
to drive it.

## Features

1. **Server lifecycle** (two modes)
   - **Managed mode** (default `opencodeBridge.serverMode = "managed"`): The
     extension always starts its **own private** `opencode serve` child on a
     free auto-chosen port with a random password. The password is generated
     by the extension and passed ONLY via the `OPENCODE_SERVER_PASSWORD` env
     var to the child process — never logged, never written to settings.json.
     The extension kills only its own child process on `deactivate`.
   - **External mode** (`opencodeBridge.serverMode = "external"`): Connect to
     an existing server at `opencodeBridge.hostname:opencodeBridge.port`.
     Password lookup: VS Code secret store → `OPENCODE_SERVER_PASSWORD` env
     var → prompt the user.

2. **Sidebar chat view** (activity bar)
   - Message list, input box, send button, Enter to send, Shift+Enter for newline.
   - Assistant replies rendered as Markdown with code blocks and a "Copy" button per code block.
   - Live streaming via the server's `/api/event` SSE stream.
   - Model dropdown in the chat header, populated from the server's `/api/provider` and `/api/model` endpoints; choice is persisted.
   - Key/lock button (external mode) to set the server password; "Enter password" button shown on 401 errors.
   - Header tooltip shows mode, server URL, and working directory.
   - "New chat" creates a fresh session (remembered while VS Code is open).
   - Loading and error states with retry. Every error is shown in the chat as
     a distinct message and written to the "OpenCode Bridge" Output channel.

3. **Editor integration**
   - `OpenCode: Ask about selection` — sends selected code + file path + line range as context (also in the editor context menu).
   - `OpenCode: Add current file` — sends the whole current file as context.
   - Keybinding `Ctrl+Alt+O` (`Cmd+Alt+O` on Mac) to open the chat.

4. **Settings** (`contributes.configuration`)
   - `opencodeBridge.port` (default `4096`) — used in external mode.
   - `opencodeBridge.hostname` (default `127.0.0.1`) — used in external mode.
   - `opencodeBridge.autoStartServer` (default `true`) — used in external mode.
   - `opencodeBridge.opencodePath` (default `"opencode"`).
   - `opencodeBridge.model` (optional `providerID/modelID`, e.g. `anthropic/claude-3-5-sonnet-20241022`).
   - `opencodeBridge.debug` (default `false`) — enable debug logging.
   - `opencodeBridge.serverMode` (`"managed"` or `"external"`, default `"managed"`).

## Requirements

- [OpenCode CLI](https://opencode.ai/docs) installed (`opencode` on PATH, or set `opencodeBridge.opencodePath`).
- A model provider configured in OpenCode (API keys set, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), since the extension does not provide any model itself.
- VS Code / VSCodium 1.85+.

## Setup

### From a .vsix file

1. Download `opencode-bridge-0.1.0.vsix` (see [Building](#building)).
2. In VS Code / VSCodium: **Extensions** → `...` → **Install from VSIX…** → select the file.
3. **Managed mode (default):** Nothing to start — the extension launches its own `opencode serve` automatically.
   **External mode:** Set `opencodeBridge.serverMode` to `"external"` and start an OpenCode server:
   ```sh
   opencode serve --port 4096
   ```
   (or set `OPENCODE_SERVER_PASSWORD` for a fixed basic-auth password).
4. Open the sidebar ("OpenCode Bridge") and start chatting.

### From source (F5)

1. `npm install`
2. `npm run compile` (TypeScript type-check)
3. `npm run lint` (ESLint)
4. Press **F5** to launch a Extension Development Host with the extension loaded.
5. Open the "OpenCode Bridge" sidebar view.

### Building a .vsix

```sh
npm run package:vsix   # npx @vscode/vsce package
```

Produces `opencode-bridge-0.1.0.vsix`.

## Configuration

Open **Settings** → **Extensions** → **OpenCode Bridge**, or edit `settings.json`:

```json
{
  "opencodeBridge.port": 4096,
  "opencodeBridge.hostname": "127.0.0.1",
  "opencodeBridge.autoStartServer": true,
  "opencodeBridge.opencodePath": "opencode",
  "opencodeBridge.model": "",
  "opencodeBridge.debug": false,
  "opencodeBridge.serverMode": "managed"
}
```

## Password handling

### Managed mode (default)

No password configuration needed. The extension generates a random password
(`crypto.randomBytes(24).toString('hex')`), starts its own `opencode serve`
child with `OPENCODE_SERVER_PASSWORD` set in the child's environment only,
and connects using Basic auth (`username: "opencode"`, `password: <random>`).
The password is kept in memory only and is never logged.

### External mode

If your `opencode serve` was started with a password, set it via:

1. **VS Code secret store** (preferred): Run the **OpenCode: Set Server Password**
   command from the Command Palette, or click the 🔑 button in the chat header.
2. **Environment variable:** Launch VS Code / VSCodium with
   `OPENCODE_SERVER_PASSWORD=your-password`.

The extension sends `Authorization: Basic opencode:<password>`. The username is
literally `opencode` (as required by the OpenCode server).

The secret key is `opencodeBridge.serverPassword`. Use
**OpenCode: Clear Server Password** to remove it.

## Commands

| Command | Keybinding | Menu |
|---|---|---|
| `OpenCode: Open Chat` | `Ctrl+Alt+O` | activity bar |
| `OpenCode: Ask about selection` | — | editor context menu |
| `OpenCode: Add current file as context` | — | editor title |
| `OpenCode: Set Server Password` | — | command palette / 🔑 button |
| `OpenCode: Clear Server Password` | — | command palette |

## Error handling

- **401/403 (auth failures)** are never retried silently. In external mode,
  the chat shows an "Enter password" button. In managed mode, this should
  not happen since the extension generates its own password.
- **Network errors, 502/503, and empty model snapshots** right after server
  start are retried with exponential backoff for up to ~10s.
- Every error is visible in the chat as a distinct message (with raw HTTP
  status and response snippet) and logged in the "OpenCode Bridge" Output
  channel (without secrets).

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| "No OpenCode server is running at …" (external mode) | Start `opencode serve --port 4096` or switch to managed mode. |
| `opencode` binary not found | Install the OpenCode CLI or set `opencodeBridge.opencodePath` to its absolute path. |
| Server doesn't become reachable within 10s | Check the Output panel (OpenCode Bridge) for server stderr; the port may be occupied. |
| Authentication required (401) | In external mode, set the password via **OpenCode: Set Server Password** or `OPENCODE_SERVER_PASSWORD`. |
| No assistant reply streams in | OpenCode needs a reachable model provider (API keys configured). The extension itself never calls an LLM. |
| Webview doesn't show / CSP errors | Reload the window; the webview uses a strict nonce-based CSP. |

## What this extension does NOT do

It does **not** implement any LLM provider, API key handling, or model routing.
All model inference happens inside the `opencode serve` process you run locally.
