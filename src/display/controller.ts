import type * as vscode from 'vscode';
import { DisplayPanel, type DisplayState } from './panel';
import { QemuScreen, ScreenFrame } from './screen';

export interface OptionalDisplayOptions { enabled?: boolean }

/** Only optional display setup failures may be downgraded by createOptional. */
export class DisplayUnavailableError extends Error {
  constructor(readonly stage: 'allocation' | 'panel', cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${stage === 'allocation' ? '显示资源分配失败' : '显示面板初始化失败'}：${reason}`, { cause });
    this.name = 'DisplayUnavailableError';
  }
}

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
  async createOptional(options: OptionalDisplayOptions = {}): Promise<QemuScreen | undefined> {
    this.trusted();
    if (this.disposed) throw new Error('显示器已释放');
    if (options.enabled === false) {
      // stop() invalidates in-flight allocations before its first await.
      const generation = this.generation + 1;
      await this.stop();
      if (generation !== this.generation || this.disposed) throw new Error('显示器启动已取消');
      this.reportStatus('stopped', '模拟显示器已关闭，运行和调试可继续使用');
      this.writeLog('模拟显示器已关闭；不分配 QMP 端口和截图目录。\n');
      return undefined;
    }
    const generation = this.generation + 1;
    try { return await this.create(); }
    catch (error) {
      if (!(error instanceof DisplayUnavailableError)) throw error;
      if (generation !== this.generation || this.disposed) throw new Error('显示器启动已取消');
      this.trusted();
      const message = `模拟显示器不可用，运行和调试将继续：${error.message}`;
      this.reportStatus('error', message);
      this.writeLog(`${message}\n`);
      return undefined;
    }
  }
  async create(): Promise<QemuScreen> {
    this.trusted();
    if (this.disposed) throw new Error('显示器已释放');
    const generation = ++this.generation;
    const previous = this.screen; this.screen = undefined;
    if (previous) await this.release(previous);
    if (generation !== this.generation || this.disposed) throw new Error('显示器启动已取消');
    const allocation = Promise.resolve().then(() => QemuScreen.create());
    this.allocations.add(allocation);
    let screen: QemuScreen;
    try { screen = await allocation; }
    catch (error) { throw new DisplayUnavailableError('allocation', error); }
    finally { this.allocations.delete(allocation); }
    if (generation !== this.generation || this.disposed) { await this.release(screen); throw new Error('显示器启动已取消'); }
    try { this.trusted(); } catch (error) { await this.release(screen); throw error; }
    this.screen = screen;
    screen.on('frame', (frame: ScreenFrame) => { if (this.screen === screen) this.panel.render(frame); });
    screen.on('status', (status: { state: 'connecting' | 'connected' | 'error' | 'stopped'; message?: string }) => {
      if (this.screen === screen) this.reportStatus(status.state, status.message);
    });
    try {
      this.panel.show();
      this.panel.setStatus('connecting', '正在等待 QEMU 屏幕');
    } catch (error) {
      if (this.screen === screen) this.screen = undefined;
      await this.release(screen);
      throw new DisplayUnavailableError('panel', error);
    }
    return screen;
  }
  async connect(screen: QemuScreen): Promise<void> {
    try { this.trusted(); await screen.connect(); }
    catch (error) {
      if (this.screen === screen) { const message = error instanceof Error ? error.message : String(error); this.reportStatus('error', message); this.writeLog(`模拟显示器：${message}\n`); }
    }
  }
  async stop(screen?: QemuScreen): Promise<void> {
    if (screen && this.screen !== screen) { await this.release(screen); return; }
    ++this.generation;
    const allocations = [...this.allocations];
    const cleanups = [...this.cleanups];
    const previous = this.screen; this.screen = undefined;
    this.reportStatus('stopped', '模拟器已停止，保留最后画面');
    if (previous) await this.release(previous);
    await Promise.all(allocations.map(allocation => allocation.then(screen => this.release(screen), () => undefined)));
    await Promise.all(cleanups);
  }
  /** A broken/disposed webview must not interrupt fallback or owned-resource cleanup. */
  private reportStatus(state: DisplayState, message?: string): void {
    try { this.panel.setStatus(state, message); }
    catch (error) { this.writeLog(`模拟显示器状态上报失败：${error instanceof Error ? error.message : String(error)}\n`); }
  }
  private writeLog(message: string): void {
    try { this.log(message); }
    catch { /* The output channel may already be disposed during shutdown. */ }
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
