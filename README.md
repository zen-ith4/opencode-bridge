# OpenCode Bridge

A VS Code / VSCodium chat client for [OpenCode](https://opencode.ai) (opencode.ai).

The extension does **not** call any LLM API itself. It connects to a local
OpenCode HTTP server (`opencode serve`), which already holds the model and API
key configuration, and uses the official [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk)
to drive it.

## Features

1. **Server lifecycle**
   - Checks whether a server is already running at the configured host/port (`GET /doc`).
   - If not, spawns `opencode serve --port <port>` (cwd = first workspace folder), waits up to ~10s, and shows a clear error if the `opencode` binary is not found.
   - Kills only the process it spawned itself on `deactivate`.
   - Optional basic auth via `OPENCODE_SERVER_PASSWORD` env var or the `opencodeBridge.serverPassword` secret.

2. **Sidebar chat view** (activity bar)
   - Message list, input box, send button, Enter to send, Shift+Enter for newline.
   - Assistant replies rendered as Markdown with code blocks and a "Copy" button per code block.
   - Live streaming via the server's `/api/event` SSE stream; `session.prompt` does not block the UI.
   - "New chat" creates a fresh session (remembered while VS Code is open).
   - Loading and error states with retry.

3. **Editor integration**
   - `OpenCode: Ask about selection` — sends selected code + file path + line range as context (also in the editor context menu).
   - `OpenCode: Add current file` — sends the whole current file as context.
   - Keybinding `Ctrl+Shift+O` (`Cmd+Shift+O` on Mac) to open the chat.

4. **Settings** (`contributes.configuration`)
   - `opencodeBridge.port` (default `4096`)
   - `opencodeBridge.hostname` (default `127.0.0.1`)
   - `opencodeBridge.autoStartServer` (default `true`)
   - `opencodeBridge.opencodePath` (default `"opencode"`)
   - `opencodeBridge.model` (optional `providerID/modelID`, e.g. `anthropic/claude-3-5-sonnet-20241022`)

## Requirements

- [OpenCode CLI](https://opencode.ai/docs) installed (`opencode` on PATH, or set `opencodeBridge.opencodePath`).
- A model provider configured in OpenCode (API keys set, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), since the extension does not provide any model itself.
- VS Code / VSCodium 1.85+.

## Setup

### From a .vsix file

1. Download `opencode-bridge-0.1.0.vsix` (see [Building](#building)).
2. In VS Code / VSCodium: **Extensions** → `...` → **Install from VSIX…** → select the file.
3. Start an OpenCode server in a terminal:
   ```sh
   opencode serve --port 4096
   ```
   (or set `OPENCODE_PASSWORD` for a fixed basic-auth password).
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
  "opencodeBridge.model": ""
}
```

### Basic auth

If your `opencode serve` was started with a password, set it via the secret store
(preferred) or environment variable:

```sh
# Option A: extension secret (per-machine, not written to settings.json)
# set via: opencode-bridge secret — see "Secret" below

# Option B: environment variable (launch VS Code / VSCodium with this)
export OPENCODE_SERVER_PASSWORD=your-password
```

The extension sends `Authorization: Basic opencode:<password>`. The username is
literally `opencode` (as required by the OpenCode server).

> There is no settings UI for the password yet; use `OPENCODE_SERVER_PASSWORD` or
> set the secret programmatically:
> ```ts
> await context.secrets.get("opencodeBridge.serverPassword")
> ```
> (The secret key is `opencodeBridge.serverPassword`.)

## Usage

- Click the **OpenCode Bridge** icon in the activity bar to open the chat sidebar.
- Type a message and press **Enter** to send. **Shift+Enter** inserts a newline.
- Click **New chat** to start a fresh session.
- In the editor, select code, right-click → **OpenCode: Ask about selection**, then type your question.
- Use **OpenCode: Add current file** from the editor title menu to include the whole file as context.

## Commands

| Command | Keybinding | Menu |
|---|---|---|
| `OpenCode: Open Chat` | `Ctrl+Shift+O` | activity bar |
| `OpenCode: Ask about selection` | — | editor context menu |
| `OpenCode: Add current file as context` | — | editor title |

## Publishing to Open VSX

This extension is published to [Open VSX](https://open-vsx.org) (compatible with VSCodium) using [`ovsx`](https://github.com/ochauti/ovsx):

```sh
npm install -g ovsx
ovsx package               # produces opencode-bridge-0.1.0.vsix
ovsx publish opencode-bridge-0.1.0.vsix --pat <YOUR_OPEN_VSX_PAT>
```

You need an Open VSX personal access token. The `engines.vscode` field is set to `^1.85.0` for broad compatibility with both VS Code and VSCodium.

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| "No OpenCode server is running at …" | Start `opencode serve --port 4096` or enable `opencodeBridge.autoStartServer`. |
| `opencode` binary not found | Install the OpenCode CLI or set `opencodeBridge.opencodePath` to its absolute path. |
| Server doesn't become reachable within 10s | Check the Output panel (OpenCode Bridge) for server stderr; the port may be occupied by something else. |
| Authentication required (401) | Set `OPENCODE_SERVER_PASSWORD` or the `opencodeBridge.serverPassword` secret. |
| No assistant reply streams in | OpenCode needs a reachable model provider (API keys configured). The extension itself never calls an LLM. |
| Webview doesn't show / CSP errors | Reload the window; the webview uses a strict nonce-based CSP. |

## What this extension does NOT do

It does **not** implement any LLM provider, API key handling, or model routing. All model inference happens inside the `opencode serve` process you run locally.

