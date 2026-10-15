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
    if (this.closed || (message as { type?: string }).type !== 'request') return;
    const request = message as unknown as Request;
    this.queue = this.queue.then(async () => {
      try {
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
        if (['launch', 'restart', 'configurationDone'].includes(request.command)) await this.launchFailed();
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.events.emit('message', { ...message, seq: this.seq++ } as unknown as DebugProtocolMessage);
  }

  close(): void {
    this.closed = true;
  }
}
