/**
 * Minimal `vscode` stub used to instantiate the real WebviewViewProvider in a
 * Node test (bundled with esbuild). Only the API surface chatView.ts touches
 * is implemented.
 */

export const window = {
  registerWebviewViewProvider() {
    return { dispose() {} };
  },
  createOutputChannel() {
    return { appendLine() {}, show() {} };
  },
};

export const workspace = {
  workspaceFolders: undefined,
  /** Returns an object whose `get` yields the caller's default value. */
  getConfiguration() {
    return { get: (_key, fallback) => fallback };
  },
  onDidChangeConfiguration() {
    return { dispose() {} };
  },
};

export const Uri = {
  file(fsPath) {
    return { fsPath, scheme: "file", toString: () => fsPath };
  },
  parse(value) {
    return { fsPath: value, scheme: "", toString: () => value };
  },
};

export const env = {
  async openExternal() {
    return true;
  },
};

export default { window, workspace, Uri, env };
