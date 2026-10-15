import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { InspectorForm, InspectorModel, parseAddress } from './model';

function attribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/** A passive debugger view. Opening or closing it never starts, resumes or stops QEMU. */
export class InspectorProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly model: InspectorModel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private ready = false;
  private disposed = false;
  private readonly sessionStates = new Map<string, 'running' | 'stopped'>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.model = new InspectorModel(state => this.post({ type: 'snapshot', ...state }));
    this.subscriptions.push(
      vscode.debug.onDidChangeActiveDebugSession(session => this.select(session)),
      vscode.debug.onDidStartDebugSession(session => {
        if (session.type === 'qemu-asm' && (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.id === session.id)) this.select(session);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        this.sessionStates.delete(session.id);
        if (this.model.isSession(session.id)) this.model.setSession(undefined);
      }),
    );
    this.select(vscode.debug.activeDebugSession);
  }

  createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    this.sessionStates.set(session.id, 'running');
    if (session.type === 'qemu-asm' && (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.id === session.id)) this.select(session);
    const ended = () => {
      this.sessionStates.delete(session.id);
      if (this.model.isSession(session.id)) this.model.setSession(undefined);
    };
    let eventVersion = 0;
    let confirmedStatus: 'running' | 'stopped' = 'running';
    const pendingMotion = new Map<number, { status: 'running' | 'stopped'; version: number }>();
    const runningCommands = ['launch', 'restart', 'continue', 'next', 'stepIn', 'stepOut', 'reverseContinue', 'stepBack', 'disconnect', 'terminate'];
    return {
      onWillReceiveMessage: (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const request = message as { type?: string; command?: string; seq?: number };
        if (request.type !== 'request' || typeof request.command !== 'string') return;
        if (runningCommands.includes(request.command)) {
          if (typeof request.seq === 'number') pendingMotion.set(request.seq, { status: confirmedStatus, version: eventVersion });
          while (pendingMotion.size > 128) pendingMotion.delete(pendingMotion.keys().next().value!);
          this.sessionStates.set(session.id, 'running');
        }
        if (this.model.isSession(session.id)) this.model.request(request.command);
      },
      onDidSendMessage: (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const packet = message as { type?: string; event?: string; command?: string; success?: boolean; request_seq?: number };
        if (packet.type === 'event') {
          if (packet.event === 'stopped') {
            eventVersion += 1; confirmedStatus = 'stopped';
            this.sessionStates.set(session.id, 'stopped');
            if (this.model.isSession(session.id)) this.model.stopped();
          } else if (packet.event === 'continued') {
            eventVersion += 1; confirmedStatus = 'running';
            this.sessionStates.set(session.id, 'running');
            if (this.model.isSession(session.id)) this.model.running();
          } else if (packet.event === 'terminated' || packet.event === 'exited') ended();
        } else if (packet.type === 'response' && typeof packet.request_seq === 'number') {
          const before = pendingMotion.get(packet.request_seq); pendingMotion.delete(packet.request_seq);
          if (packet.success === false && before && before.version === eventVersion && packet.command
            && ['continue', 'next', 'stepIn', 'stepOut', 'reverseContinue', 'stepBack', 'restart'].includes(packet.command)) {
            this.sessionStates.set(session.id, before.status);
            if (this.model.isSession(session.id)) {
              if (before.status === 'stopped') this.model.stopped(); else this.model.running();
            }
          }
        }
      },
      onError: ended,
      onExit: ended,
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.releaseView();
    this.view = view; this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((value: unknown) => { if (this.view === view) this.receive(value); }),
      view.onDidChangeVisibility(() => { if (this.view === view) this.model.setVisible(view.visible && this.ready); }),
      view.onDidDispose(() => { if (this.view === view) this.releaseView(); }),
    ];
    view.webview.html = renderInspectorHtml(view.webview, media);
  }

  private receive(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object') return;
    const message = value as { type?: unknown; form?: unknown; address?: unknown; tab?: unknown; follow?: unknown; direction?: unknown };
    if (message.type === 'ready') {
      this.ready = true;
      if (message.form && typeof message.form === 'object') this.model.configure(message.form as Partial<InspectorForm>);
      this.model.setVisible(this.view?.visible === true);
      this.post({ type: 'snapshot', ...this.model.snapshot });
    } else if (message.type === 'refresh') this.model.refresh();
    else if (message.type === 'configure' && message.form && typeof message.form === 'object') this.model.configure(message.form as Partial<InspectorForm>);
    else if (message.type === 'address') {
      const address = parseAddress(message.address);
      if (address === undefined) this.post({ type: 'notice', message: '请输入 0 到 0xFFFFFFFF 的地址；支持十进制或以 0x 开头的十六进制。' });
      else this.model.configure({ address, follow: 'address' });
    } else if (message.type === 'navigate' && (message.direction === -1 || message.direction === 1)) {
      const form = this.model.snapshot.form;
      if (form.tab === 'memory') {
        const address = this.model.snapshot.memory?.address ?? form.address;
        this.model.configure({ address: Math.max(0, Math.min(0xffffff00, address + message.direction * 256)), follow: 'address' });
      } else {
        const table = this.model.snapshot[form.tab];
        const key = form.tab === 'gdt' ? 'gdtStart' : 'idtStart';
        const next = Math.max(0, form[key] + message.direction * 64);
        if (next < (table?.totalEntries ?? 8192)) this.model.configure({ [key]: next });
      }
    }
  }
  private select(session?: vscode.DebugSession): void {
    if (this.disposed) return;
    const selected = session?.type === 'qemu-asm' ? session : undefined;
    this.model.setSession(selected);
    if (selected && this.sessionStates.get(selected.id) === 'stopped' && this.model.snapshot.status !== 'stopped') this.model.stopped();
  }
  private post(message: object): void {
    if (!this.disposed && this.ready && this.view) void this.view.webview.postMessage(message).then(undefined, () => undefined);
  }
  private releaseView(): void {
    this.view = undefined; this.ready = false; this.model.setVisible(false);
    const subscriptions = this.viewSubscriptions; this.viewSubscriptions = [];
    for (const subscription of subscriptions) subscription.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.releaseView(); this.model.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.sessionStates.clear();
  }
}

export function renderInspectorHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const script = attribute(webview.asWebviewUri(vscode.Uri.joinPath(media, 'inspector.js')).toString());
  const style = attribute(webview.asWebviewUri(vscode.Uri.joinPath(media, 'inspector.css')).toString());
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attribute(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>内存与描述符</title></head>
<body><main>
<header class="toolbar"><nav class="tabs" role="tablist" aria-label="调试观察内容"><button id="tab-memory" role="tab" aria-selected="true" aria-controls="memory-view" data-tab="memory">内存</button><button id="tab-gdt" role="tab" aria-selected="false" aria-controls="descriptor-view" data-tab="gdt" tabindex="-1">GDT</button><button id="tab-idt" role="tab" aria-selected="false" aria-controls="descriptor-view" data-tab="idt" tabindex="-1">IDT</button></nav><span class="live-label">QEMU · 暂停快照</span><button id="refresh" class="secondary" disabled title="重新读取当前暂停状态">刷新</button></header>
<div class="status" role="status" aria-live="polite"><span id="status-dot" class="dot idle" aria-hidden="true"></span><span id="status">等待调试会话</span><span id="stale" hidden>上次快照</span></div>
<section id="memory-view" role="tabpanel" aria-labelledby="tab-memory"><form id="address-form" class="controls"><label for="address">线性地址</label><input id="address" value="0x00007C00" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="address-hint"><button id="go" type="submit" disabled>查看</button><label class="follow-label" for="follow">跟随</label><select id="follow"><option value="address">固定地址</option><option value="esp">SS:ESP / SP</option><option value="ebp">SS:EBP / BP</option></select><span class="spacer"></span><button id="memory-prev" type="button" class="secondary" disabled aria-label="前 256 字节">← 前页</button><button id="memory-next" type="button" class="secondary" disabled aria-label="后 256 字节">后页 →</button></form>
<div class="memory-meta"><span id="address-hint">十六进制以 0x 开头；每页 256 字节</span><span id="memory-range"></span><span class="legend"><i aria-hidden="true"></i> 相比已读快照发生变化</span></div>
<div class="table-scroll"><table class="hex-table" aria-label="内存十六进制和 ASCII"><thead><tr id="hex-head"><th scope="col">地址</th></tr></thead><tbody id="memory-body"></tbody></table></div></section>
<section id="descriptor-view" role="tabpanel" aria-labelledby="tab-gdt" hidden><div class="controls descriptor-controls"><strong id="descriptor-title">全局描述符表</strong><span id="table-meta"></span><span class="spacer"></span><span id="table-page"></span><button id="descriptor-prev" class="secondary" disabled>← 前页</button><button id="descriptor-next" class="secondary" disabled>后页 →</button></div><p id="table-warnings" class="warnings" hidden></p><div class="table-scroll"><table class="descriptor-table" aria-label="描述符表"><thead><tr id="descriptor-head"></tr></thead><tbody id="descriptor-body"></tbody></table></div><p class="hint" id="descriptor-hint">段寄存器使用 CPU 缓存的描述符；修改 GDT 后需重新加载段寄存器。</p></section>
<div id="empty" class="empty"><strong>把 CPU 暂停下来，看看它正在使用什么。</strong><span>内存、段描述符和中断入口会随断点与单步自动更新。</span></div><p id="notice" class="notice" role="alert" hidden></p>
</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
