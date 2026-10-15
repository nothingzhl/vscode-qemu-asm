import { EventEmitter } from 'node:events';
import type { DebugProtocolMessage, Disposable, Event } from 'vscode';
import type { Request } from './protocol';

/** Owns DAP sequencing and serialized dispatch; session owners retain lifecycle decisions. */
export class DapChannel {
  private readonly events = new EventEmitter();
  private seq = 1;
  private closed = false;
  queue: Promise<void> = Promise.resolve();

  readonly onDidSendMessage: Event<DebugProtocolMessage> = (listener, thisArgs?, disposables?) => {
    const fn = (message: DebugProtocolMessage) => listener.call(thisArgs, message);
    this.events.on('message', fn);
    const disposable: Disposable = { dispose: () => this.events.off('message', fn) };
    disposables?.push(disposable);
    return disposable;
  };

  constructor(
    private readonly dispatch: (request: Request) => Promise<void>,
    private readonly launchFailed: () => Promise<void>,
    private readonly inlineErrors: readonly string[]
  ) {}

  handleMessage(message: DebugProtocolMessage): void {
    if (
      this.closed ||
      !message ||
      typeof message !== 'object' ||
      (message as { type?: string }).type !== 'request'
    )
      return;
    const request = message as unknown as Request;
    if (
      !Number.isSafeInteger(request.seq) ||
      request.seq < 0 ||
      typeof request.command !== 'string' ||
      !request.command
    )
      return;
    this.queue = this.queue.then(async () => {
      try {
        if (
          request.arguments !== undefined &&
          (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments))
        )
          throw new Error('调试请求参数必须是对象');
        await this.dispatch(request);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.send({
          type: 'response',
          request_seq: request.seq,
          command: request.command,
          success: false,
          message: text,
          body: { error: { id: 1, format: text, showUser: !this.inlineErrors.includes(request.command) } }
        });
        if (['launch', 'restart', 'configurationDone'].includes(request.command)) await this.finish();
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.events.emit('message', { ...message, seq: this.seq++ } as unknown as DebugProtocolMessage);
  }

  /** Stop-event failures use the same cleanup path without poisoning later requests. */
  async fail(error: unknown): Promise<void> {
    this.output(error);
    await this.finish();
  }

  private async finish(): Promise<void> {
    try {
      await this.launchFailed();
    } catch (error) {
      this.output(new Error(`调试资源清理失败：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private output(error: unknown): void {
    this.send({
      type: 'event',
      event: 'output',
      body: { category: 'stderr', output: `${error instanceof Error ? error.message : String(error)}\n` }
    });
  }

  close(): void {
    this.closed = true;
  }
}
