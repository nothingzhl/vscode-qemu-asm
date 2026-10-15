import type * as vscode from 'vscode';
import { DisplayPanel } from './panel';
import { QemuScreen, ScreenFrame } from './screen';

/** 一个插件窗口只有一个活动显示源；面板关闭后仍可重新打开最后画面。 */
export class DisplayController {
  private readonly panel: DisplayPanel;
  private screen?: QemuScreen;
  private generation = 0;
  private disposed = false;
  private cleanups = new Set<Promise<void>>();
  private allocations = new Set<Promise<QemuScreen>>();
  private disposal?: Promise<void>;
  constructor(context: vscode.ExtensionContext, private readonly trusted: () => void, private readonly log: (message: string) => void) {
    this.panel = new DisplayPanel(context, {
      onKey: async key => { this.trusted(); if (!this.screen) throw new Error('请先运行或调试项目，再向显示器发送按键'); await this.screen.sendKey(key); },
      onRefresh: async () => { this.trusted(); const screen = this.screen; if (screen) { const frame = await screen.capture(); if (this.screen === screen) this.panel.render(frame); } }
    });
  }
  show(): void { this.panel.show(); }
  async create(): Promise<QemuScreen> {
    this.trusted();
    if (this.disposed) throw new Error('显示器已释放');
    const generation = ++this.generation;
    const previous = this.screen; this.screen = undefined;
    if (previous) await this.release(previous);
    if (generation !== this.generation || this.disposed) throw new Error('显示器启动已取消');
    const allocation = QemuScreen.create();
    this.allocations.add(allocation);
    let screen: QemuScreen;
    try { screen = await allocation; } finally { this.allocations.delete(allocation); }
    if (generation !== this.generation || this.disposed) { await this.release(screen); throw new Error('显示器启动已取消'); }
    this.screen = screen;
    screen.on('frame', (frame: ScreenFrame) => { if (this.screen === screen) this.panel.render(frame); });
    screen.on('status', (status: { state: 'connecting' | 'connected' | 'error' | 'stopped'; message?: string }) => {
      if (this.screen === screen) this.panel.setStatus(status.state, status.message);
    });
    this.panel.show();
    this.panel.setStatus('connecting', '正在等待 QEMU 屏幕');
    return screen;
  }
  async connect(screen: QemuScreen): Promise<void> {
    try { this.trusted(); await screen.connect(); }
    catch (error) {
      if (this.screen === screen) { const message = error instanceof Error ? error.message : String(error); this.panel.setStatus('error', message); this.log(`模拟显示器：${message}\n`); }
    }
  }
  async stop(screen?: QemuScreen): Promise<void> {
    if (screen && this.screen !== screen) { await this.release(screen); return; }
    ++this.generation;
    const allocations = [...this.allocations];
    const cleanups = [...this.cleanups];
    const previous = this.screen; this.screen = undefined;
    this.panel.setStatus('stopped', '模拟器已停止，保留最后画面');
    if (previous) await this.release(previous);
    await Promise.all(allocations.map(allocation => allocation.then(screen => this.release(screen), () => undefined)));
    await Promise.all(cleanups);
  }
  private release(screen: QemuScreen): Promise<void> {
    const cleanup = screen.dispose();
    this.cleanups.add(cleanup);
    void cleanup.then(() => this.cleanups.delete(cleanup), () => this.cleanups.delete(cleanup));
    return cleanup;
  }
  dispose(): Promise<void> {
    if (!this.disposal) { this.disposed = true; this.disposal = this.stop().finally(() => this.panel.dispose()); }
    return this.disposal;
  }
}
