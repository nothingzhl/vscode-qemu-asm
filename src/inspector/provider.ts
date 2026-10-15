import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { InspectorForm, InspectorModel, InspectorTab, parseAddress, WatchAccess } from './model';

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
  private requestedTab?: InspectorTab;
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
          if (packet.success && ['setInstructionBreakpoints', 'setDataBreakpoints'].includes(packet.command ?? '') && this.model.isSession(session.id)) this.model.refresh();
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

  async show(tab: InspectorTab): Promise<void> {
    if (this.disposed) return;
    this.requestedTab = tab;
    this.model.configure({ tab });
    await vscode.commands.executeCommand('qemuAsm.inspector.focus');
    this.model.configure({ tab });
    if (this.ready) this.requestedTab = undefined;
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
    const message = value as { type?: unknown; form?: unknown; address?: unknown; tab?: unknown; follow?: unknown; direction?: unknown; enabled?: unknown; action?: unknown; size?: unknown; access?: unknown; id?: unknown; generation?: unknown; sessionId?: unknown };
    if (message.type === 'ready') {
      this.ready = true;
      if (message.form && typeof message.form === 'object') this.model.configure(message.form as Partial<InspectorForm>);
      if (this.requestedTab) { this.model.configure({ tab: this.requestedTab }); this.requestedTab = undefined; }
      this.model.setVisible(this.view?.visible === true);
      this.post({ type: 'snapshot', ...this.model.snapshot });
    } else if (message.type === 'refresh') this.model.refresh();
    else if (message.type === 'configure' && message.form && typeof message.form === 'object') this.model.configure(message.form as Partial<InspectorForm>);
    else if (message.type === 'address') {
      const address = parseAddress(message.address);
      if (address === undefined) this.post({ type: 'notice', message: '请输入 0 到 0xFFFFFFFF 的地址；支持十进制或以 0x 开头的十六进制。' });
      else this.model.configure({ address, follow: 'address' });
    } else if (message.type === 'pagingAddress') {
      const address = parseAddress(message.address);
      if (address === undefined) this.post({ type: 'notice', message: '请输入有效的 32 位虚拟线性地址。' });
      else this.model.configure({ pagingAddress: address });
    } else if (message.type === 'disassemblyAddress') {
      const address = parseAddress(message.address);
      if (address === undefined) this.post({ type: 'notice', message: '请输入有效的 32 位线性地址。' });
      else this.model.configure({ disassemblyAddress: address, disassemblyFollow: false });
    } else if (message.type === 'instructionBreakpoint' || message.type === 'watchpoint') {
      if (this.model.snapshot.status !== 'stopped' || this.model.snapshot.busy || this.model.snapshot.stale
        || message.generation !== this.model.snapshot.generation || message.sessionId !== this.model.snapshot.sessionId) return;
      if (!vscode.workspace.isTrusted) { this.post({ type: 'notice', message: '修改断点需要受信任的工作区。' }); return; }
      if (message.type === 'instructionBreakpoint') {
        if (Number.isInteger(message.address) && (message.address as number) >= 0 && (message.address as number) <= 0xffffffff && typeof message.enabled === 'boolean') {
          void this.model.changeInstructionBreakpoint(message.address as number, message.enabled);
        }
      } else if (message.action === 'add') {
        const address = parseAddress(message.address);
        if (address === undefined || ![1, 2, 4].includes(message.size as number) || !['write', 'read', 'readWrite'].includes(message.access as string)) {
          this.post({ type: 'notice', message: '请输入有效地址，选择 1、2 或 4 字节及访问方式。' }); return;
        }
        if (address + (message.size as number) > 0x100000000) {
          this.post({ type: 'notice', message: '数据断点范围不能超出 32 位地址空间。' }); return;
        }
        void this.model.changeWatchpoint('add', { address, size: message.size as number, access: message.access as WatchAccess });
      } else if (message.action === 'remove' && Number.isSafeInteger(message.id)) void this.model.changeWatchpoint('remove', { id: message.id as number });
      else if (message.action === 'clear') void this.model.changeWatchpoint('clear', {});
    } else if (message.type === 'disassemblyNext') {
      const next = this.model.snapshot.disassembly?.nextAddress;
      if (next !== undefined && next <= 0xffffffff) this.model.configure({ disassemblyAddress: next, disassemblyFollow: false });
    } else if (message.type === 'navigate' && (message.direction === -1 || message.direction === 1)) {
      const form = this.model.snapshot.form;
      if (form.tab === 'memory') {
        const address = this.model.snapshot.memory?.address ?? form.address;
        this.model.configure({ address: Math.max(0, Math.min(0xffffff00, address + message.direction * 256)), follow: 'address' });
      } else if (form.tab === 'gdt' || form.tab === 'idt') {
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
<link rel="stylesheet" href="${style}"><title>QEMU 调试观察</title></head>
<body><main>
<header class="toolbar"><nav class="tabs" role="tablist" aria-label="调试观察内容"><button id="tab-memory" role="tab" aria-selected="true" aria-controls="memory-view" data-tab="memory">内存</button><button id="tab-disassembly" role="tab" aria-selected="false" aria-controls="disassembly-view" data-tab="disassembly" tabindex="-1">反汇编</button><button id="tab-watchpoints" role="tab" aria-selected="false" aria-controls="watchpoint-view" data-tab="watchpoints" tabindex="-1">数据断点</button><button id="tab-paging" role="tab" aria-selected="false" aria-controls="paging-view" data-tab="paging" tabindex="-1">页表</button><button id="tab-gdt" role="tab" aria-selected="false" aria-controls="descriptor-view" data-tab="gdt" tabindex="-1">GDT</button><button id="tab-idt" role="tab" aria-selected="false" aria-controls="descriptor-view" data-tab="idt" tabindex="-1">IDT</button></nav><span class="live-label">QEMU · 暂停快照</span><button id="refresh" class="secondary" disabled title="重新读取当前暂停状态">刷新</button></header>
<div class="status" role="status" aria-live="polite"><span id="status-dot" class="dot idle" aria-hidden="true"></span><span id="status">等待调试会话</span><span id="stale" hidden>上次快照</span></div>
<section id="memory-view" role="tabpanel" aria-labelledby="tab-memory"><form id="address-form" class="controls"><label for="memory-space">地址空间</label><select id="memory-space"><option value="virtual">虚拟内存</option><option value="physical">物理内存</option></select><label id="memory-address-label" for="address">虚拟线性地址</label><input id="address" value="0x00007C00" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="address-hint"><button id="go" type="submit" disabled>查看</button><label class="follow-label" for="follow">跟随</label><select id="follow"><option value="address">固定地址</option><option value="esp">SS:ESP / SP</option><option value="ebp">SS:EBP / BP</option></select><span class="spacer"></span><button id="memory-prev" type="button" class="secondary" disabled aria-label="前 256 字节">← 前页</button><button id="memory-next" type="button" class="secondary" disabled aria-label="后 256 字节">后页 →</button></form>
<div class="memory-meta"><span id="address-hint">十六进制以 0x 开头；每页 256 字节</span><span id="memory-range"></span><span id="memory-context"></span><span class="legend"><i aria-hidden="true"></i> 相比已读快照发生变化</span></div>
<div class="table-scroll"><table class="hex-table" aria-label="内存十六进制和 ASCII"><thead><tr id="hex-head"><th scope="col">地址</th></tr></thead><tbody id="memory-body"></tbody></table></div></section>
<section id="descriptor-view" role="tabpanel" aria-labelledby="tab-gdt" hidden><div class="controls descriptor-controls"><strong id="descriptor-title">全局描述符表</strong><span id="table-meta"></span><span class="spacer"></span><span id="table-page"></span><button id="descriptor-prev" class="secondary" disabled>← 前页</button><button id="descriptor-next" class="secondary" disabled>后页 →</button></div><p id="table-warnings" class="warnings" hidden></p><div class="table-scroll"><table class="descriptor-table" aria-label="描述符表"><thead><tr id="descriptor-head"></tr></thead><tbody id="descriptor-body"></tbody></table></div><p class="hint" id="descriptor-hint">段寄存器使用 CPU 缓存的描述符；修改 GDT 后需重新加载段寄存器。</p></section>
<section id="paging-view" role="tabpanel" aria-labelledby="tab-paging" hidden><form id="paging-form" class="controls"><label for="paging-address">虚拟线性地址</label><input id="paging-address" value="0x00007C00" spellcheck="false" autocomplete="off"><button id="paging-go" type="submit" disabled>转换地址</button><span class="spacer"></span><span id="paging-meta"></span></form>
<div id="paging-path" class="paging-path" aria-label="虚拟到物理地址转换"></div><div id="paging-result" class="paging-result" role="status"></div>
<div class="table-scroll"><table class="paging-table" aria-label="物理内存中的页目录项和页表项"><thead><tr><th>层级 / 索引</th><th>表项物理地址</th><th>原始值</th><th>基址</th><th>P</th><th>R/W</th><th>U/S</th><th>标志</th></tr></thead><tbody id="paging-body"></tbody></table></div>
<div id="paging-permissions" class="paging-permissions"></div><p id="paging-explanation" class="hint"></p><p id="paging-warnings" class="warnings" hidden></p></section>
<section id="disassembly-view" role="tabpanel" aria-labelledby="tab-disassembly" hidden><form id="disassembly-form" class="controls"><label for="disassembly-address">线性地址</label><input id="disassembly-address" value="0x00007C00" spellcheck="false" autocomplete="off"><button id="disassembly-go" type="submit" disabled>跳转</button><label class="checkbox-label"><input id="disassembly-follow" type="checkbox" checked>跟随当前指令</label><span id="disassembly-meta"></span><span class="spacer"></span><button id="disassembly-next" class="secondary" type="button" disabled>后 64 条 →</button></form><div class="table-scroll"><table class="disassembly-table" aria-label="反汇编指令"><thead><tr><th>断点</th><th>地址</th><th>机器码</th><th>指令</th></tr></thead><tbody id="disassembly-body"></tbody></table></div><p class="hint">点击断点栏设置地址断点；VS Code 原生断点需在原生断点视图中删除。无效或不完整指令显示为不可用；手动地址需指向指令起点。</p></section>
<section id="watchpoint-view" role="tabpanel" aria-labelledby="tab-watchpoints" hidden><form id="watchpoint-form" class="controls"><label for="watchpoint-address">线性地址</label><input id="watchpoint-address" value="0x00007C00" spellcheck="false" autocomplete="off"><label for="watchpoint-size">大小</label><select id="watchpoint-size"><option value="1">1 字节</option><option value="2">2 字节</option><option value="4" selected>4 字节</option></select><label for="watchpoint-access">访问</label><select id="watchpoint-access"><option value="write">写入</option><option value="read">读取</option><option value="readWrite">读取或写入</option></select><button id="watchpoint-add" type="submit" disabled>添加</button><span class="spacer"></span><button id="watchpoint-clear" class="secondary" type="button" disabled>清除面板断点</button></form><p id="watchpoint-hit" class="hit-message" hidden></p><div class="table-scroll"><table class="watchpoint-table" aria-label="数据断点"><thead><tr><th>状态</th><th>地址</th><th>大小</th><th>访问方式</th><th>来源</th><th>操作</th></tr></thead><tbody id="watchpoint-body"></tbody></table></div><p class="hint">监视 1、2 或 4 字节。数据断点在访问完成后暂停；列表显示已启用的断点。暂停时可添加和删除。</p></section>
<div id="empty" class="empty"><strong>把 CPU 暂停下来，看看它正在使用什么。</strong><span>指令、内存和描述符会随断点与单步自动更新。</span></div><p id="notice" class="notice" role="alert" hidden></p>
</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
