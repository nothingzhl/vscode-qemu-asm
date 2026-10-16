import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface DisplayFrame {
  png: Buffer;
  width: number;
  height: number;
}

export type DisplayState = 'connecting' | 'connected' | 'error' | 'stopped';

export interface DisplayPanelOptions {
  onKey?: (key: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
}

const keys = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  'up', 'down', 'left', 'right', 'ret', 'esc', 'spc', 'backspace', 'tab',
  'delete', 'insert', 'home', 'end', 'pgup', 'pgdn', 'shift', 'ctrl', 'alt',
  'minus', 'equal', 'bracket_left', 'bracket_right', 'backslash', 'semicolon',
  'apostrophe', 'grave_accent', 'comma', 'dot', 'slash', 'caps_lock',
]);

function validKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 60) return false;
  const parts = key.split('-');
  return parts.length > 0 && parts.length <= 4 && new Set(parts).size === parts.length
    && parts.every(part => keys.has(part));
}

function validFrame(frame: DisplayFrame): boolean {
  return Number.isInteger(frame.width) && Number.isInteger(frame.height)
    && frame.width > 0 && frame.height > 0 && frame.width <= 8192 && frame.height <= 8192
    && frame.width * frame.height <= 32 * 1024 * 1024
    && Buffer.isBuffer(frame.png) && frame.png.length >= 24 && frame.png.length <= 32 * 1024 * 1024
    && frame.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && frame.png.toString('ascii', 12, 16) === 'IHDR'
    && frame.png.readUInt32BE(16) === frame.width && frame.png.readUInt32BE(20) === frame.height;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/** The monitor is only a viewer: closing it never stops the guest. */
export class DisplayPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private panelDisposables: vscode.Disposable[] = [];
  private framePng?: Buffer;
  private frame?: { type: 'frame'; data: string; width: number; height: number };
  private state: DisplayState = 'stopped';
  private message = '尚未启动模拟器';
  private disposed = false;
  private ready = false;
  private keyQueue: Promise<void> = Promise.resolve();
  private pendingKeys = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly options: DisplayPanelOptions = {}) {}

  show(): void {
    if (this.disposed) return;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, true);
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('qemuAsm.display', 'QEMU 模拟显示器', {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
    }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel = panel;
    this.ready = false;
    this.panelDisposables = [
      panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.ready = false;
        this.releasePanelEvents();
      }),
      panel.webview.onDidReceiveMessage((value: unknown) => {
        if (!value || typeof value !== 'object' || this.panel !== panel) return;
        const message = value as { type?: unknown; key?: unknown };
        if (message.type === 'ready') {
          this.ready = true;
          this.post({ type: 'status', state: this.state, message: this.message });
          if (this.frame) this.post(this.frame);
        } else if (message.type === 'refresh') {
          this.framePng = undefined; // Explicit refresh retries a failed webview decode or transfer.
          void this.runAction(this.options.onRefresh);
        } else if (message.type === 'key' && validKey(message.key) && this.state === 'connected'
          && this.options.onKey && this.pendingKeys < 32) {
          const key = message.key;
          this.pendingKeys += 1;
          this.keyQueue = this.keyQueue.then(async () => {
            if (!this.disposed && this.panel === panel && this.state === 'connected') {
              await this.runAction(() => this.options.onKey!(key));
            }
          }).finally(() => { this.pendingKeys -= 1; });
        }
      }),
    ];
    panel.webview.html = renderWebviewHtml(panel.webview, media);
  }

  render(frame: DisplayFrame): void {
    if (this.disposed) return;
    if (!validFrame(frame)) {
      this.setStatus('error', '显示器收到无效的 PNG 画面');
      return;
    }
    // ScreenFrames reuses the PNG object when the guest display is unchanged.
    if (frame.png === this.framePng) return;
    this.framePng = frame.png;
    this.frame = { type: 'frame', data: `data:image/png;base64,${frame.png.toString('base64')}`, width: frame.width, height: frame.height };
    this.post(this.frame);
  }

  setStatus(state: DisplayState, message?: string): void {
    if (this.disposed) return;
    this.state = state;
    if (state === 'stopped') this.framePng = undefined;
    this.message = message ?? ({ connecting: '正在连接 QEMU', connected: '正在显示 QEMU 画面', error: '显示器连接失败', stopped: '模拟器已停止，保留最后画面' }[state]);
    this.post({ type: 'status', state, message: this.message });
  }

  private post(message: object): void {
    if (this.ready && this.panel) void this.panel.webview.postMessage(message).then(undefined, () => undefined);
  }

  private async runAction(action?: () => Promise<void>): Promise<void> {
    if (!action) return;
    try { await action(); }
    catch (error) { this.post({ type: 'notice', message: error instanceof Error ? error.message : String(error) }); }
  }

  private releasePanelEvents(): void {
    const events = this.panelDisposables;
    this.panelDisposables = [];
    for (const event of events) event.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.releasePanelEvents();
    panel?.dispose();
    this.frame = undefined;
    this.framePng = undefined;
  }
}

export function renderWebviewHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const script = escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(media, 'display.js')).toString());
  const style = escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(media, 'display.css')).toString());
  const cspSource = escapeAttribute(webview.cspSource);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>QEMU 模拟显示器</title>
</head>
<body>
  <main class="monitor">
    <header class="toolbar">
      <div class="identity"><span class="monitor-icon" aria-hidden="true">▣</span><strong>模拟显示器</strong><span class="source">QEMU VGA</span></div>
      <div class="actions">
        <div class="scale-group" role="group" aria-label="画面缩放">
          <button id="fit" class="scale active" aria-pressed="true" title="等比例适应可用空间">适应</button>
          <button id="actual" class="scale" aria-pressed="false" title="一个图像像素对应一个 CSS 像素">1:1</button>
        </div>
        <button id="refresh" title="重新读取模拟器画面">刷新</button>
      </div>
    </header>
    <div class="status-line" role="status" aria-live="polite"><span id="status-dot" class="status-dot stopped" aria-hidden="true"></span><span id="status">尚未启动模拟器</span><span id="dimensions"></span></div>
    <div id="screen" class="screen fit" tabindex="0" role="application" aria-label="QEMU 模拟显示器，开启键盘输入后点击此处将按键发送到模拟器">
      <img id="frame" alt="QEMU 模拟器的 VGA 显示画面" draggable="false" hidden>
      <div id="placeholder" class="placeholder"><span class="placeholder-icon" aria-hidden="true">▣</span><strong>等待模拟器画面</strong><span>运行或调试引导程序后，屏幕会显示在这里</span></div>
    </div>
    <footer class="keyboard-bar">
      <button id="keyboard" aria-pressed="false" disabled>开启键盘输入</button>
      <span id="keyboard-hint">键盘输入已关闭</span>
      <button id="reset-keys" class="secondary" disabled title="向模拟器发送 Ctrl + Alt + Delete">Ctrl + Alt + Del</button>
    </footer>
    <p id="notice" class="notice" role="alert" hidden></p>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
