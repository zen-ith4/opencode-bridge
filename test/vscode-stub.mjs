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

export default { window, Uri, env };
