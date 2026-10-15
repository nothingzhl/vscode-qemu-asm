import { EventEmitter } from 'node:events';
import * as net from 'node:net';

export class QmpError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'QmpError'; }
}

interface Request {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** An independent, local QMP connection. Replies are matched by id, never by arrival order. */
export class QmpClient extends EventEmitter {
  private input = Buffer.alloc(0);
  private readonly requests = new Map<number, Request>();
  private nextId = 1;
  private closed = false;
  private greeted = false;
  private resolveGreeting!: () => void;
  private rejectGreeting!: (error: Error) => void;
  private readonly greeting = new Promise<void>((resolve, reject) => {
    this.resolveGreeting = resolve; this.rejectGreeting = reject;
  });

  private constructor(private readonly socket: net.Socket, private readonly requestTimeout: number) {
    super();
    // A connection may fail before connect() begins awaiting the greeting.
    void this.greeting.catch(() => undefined);
    socket.on('data', data => this.receive(data));
    socket.on('error', error => this.disconnect(error));
    socket.on('close', () => this.disconnect(new Error('QEMU 显示连接已断开')));
  }

  static async connect(port: number, timeout = 1000, requestTimeout = 3000, signal?: AbortSignal): Promise<QmpClient> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的 QMP 本地端口');
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    const client = new QmpClient(socket, requestTimeout);
    const abort = () => client.close();
    const timer = setTimeout(() => client.disconnect(new Error('连接 QEMU 显示接口超时')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('QEMU 显示连接已取消');
      await client.greeting;
      await client.command('qmp_capabilities');
      return client;
    } catch (error) { client.close(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  command(execute: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('QEMU 显示连接已关闭'));
    if (!this.greeted) return Promise.reject(new Error('QMP 尚未完成握手'));
    if (this.requests.size >= 64) return Promise.reject(new Error('QEMU 显示请求过多'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`QEMU 显示请求超时：${execute}`));
        this.disconnect(new Error('QEMU 显示请求超时，连接已关闭'));
      }, this.requestTimeout);
      this.requests.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ execute, ...(args ? { arguments: args } : {}), id }) + '\r\n', error => {
        if (error) this.disconnect(error);
      });
    });
  }

  close(): void { this.disconnect(new Error('QEMU 显示连接已关闭')); }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    if (!this.greeted) this.rejectGreeting(error);
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    this.emit('disconnect', error);
  }

  private receive(data: Buffer): void {
    if (this.closed) return;
    this.input = Buffer.concat([this.input, data]);
    if (this.input.length > 4 * 1024 * 1024) { this.disconnect(new Error('QMP 数据包过大')); return; }
    for (;;) {
      const end = this.input.indexOf(10);
      if (end < 0) return;
      const line = this.input.subarray(0, end).toString('utf8').trim();
      this.input = this.input.subarray(end + 1);
      if (!line) continue;
      let packet: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid packet');
        packet = parsed as Record<string, unknown>;
      } catch { this.disconnect(new Error('QEMU 返回无效的 QMP JSON')); return; }
      if ('QMP' in packet && !this.greeted) { this.greeted = true; this.resolveGreeting(); continue; }
      if (typeof packet.event === 'string') { this.emit('event', packet); continue; }
      if (typeof packet.id !== 'number') continue;
      const pending = this.requests.get(packet.id);
      if (!pending) continue;
      this.requests.delete(packet.id);
      clearTimeout(pending.timer);
      if (packet.error && typeof packet.error === 'object') {
        const failure = packet.error as Record<string, unknown>;
        pending.reject(new QmpError(String(failure.class ?? 'GenericError'), `QEMU 显示请求失败：${String(failure.desc ?? failure.class ?? '未知错误')}`));
      } else if ('return' in packet) pending.resolve(packet.return);
      else pending.reject(new Error('QEMU 返回无效的 QMP 回复'));
    }
  }
}
