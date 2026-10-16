import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { decodePayload } from './codec';

/** QEMU 的 GDB Remote Serial Protocol；所有请求串行，停止通知异步到达。 */
export class RspClient extends EventEmitter {
  private incoming = Buffer.alloc(0);
  private pending?: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    console: string[];
    expectsStop: boolean;
  };
  private queue: Promise<unknown> = Promise.resolve();
  private lastPacket?: Buffer;
  private retries = 0;
  private closed = false;
  private constructor(
    private readonly socket: net.Socket,
    private readonly timeout: number
  ) {
    super();
    socket.on('data', (data) => this.receive(data));
    socket.on('error', (error) => this.disconnect(error));
    socket.on('close', () => this.disconnect(new Error('QEMU 调试连接已断开')));
  }

  static connect(
    port: number,
    host = '127.0.0.1',
    timeout = 5000,
    commandTimeout = 5000
  ): Promise<RspClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('连接 QEMU 调试接口超时'));
      }, timeout);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        socket.setNoDelay(true);
        resolve(new RspClient(socket, commandTimeout));
      });
    });
  }

  command(payload: string): Promise<string> {
    return this.enqueue(() => this.request(payload));
  }

  /** 临时改变 QEMU 全局状态时，整个请求组独占队列，包含失败后的恢复请求。 */
  transaction<T>(action: (command: (payload: string) => Promise<string>) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      let active = true;
      let requests: Promise<unknown> = Promise.resolve();
      const command = (payload: string): Promise<string> => {
        if (!active) return Promise.reject(new Error('QEMU 调试请求事务已经结束'));
        const request = requests.then(() => this.request(payload));
        requests = request.catch(() => undefined);
        return request;
      };
      try {
        return await action(command);
      } finally {
        active = false;
        await requests;
      }
    });
  }

  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const operation = this.queue.then(() => {
      if (this.closed) throw new Error('QEMU 调试连接已关闭');
      return action();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private request(payload: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('QEMU 调试连接已关闭'));
        return;
      }
      const timer = setTimeout(() => {
        const error = new Error(`QEMU 调试请求超时：${payload.slice(0, 60)}`);
        this.pending = undefined;
        reject(error);
        // 超时后无法可靠地把迟到的数据匹配到下一条请求。
        this.close();
      }, this.timeout);
      this.pending = { resolve, reject, timer, console: [], expectsStop: payload === '?' };
      this.send(payload);
    });
  }

  /** continue/step 的停止回复可能几分钟后才出现，不占用请求队列。 */
  resume(step = false): Promise<void> {
    return this.enqueue(() => {
      this.send(step ? 's' : 'c');
    });
  }

  interrupt(): Promise<void> {
    return this.enqueue(() => {
      this.socket.write(Buffer.from([3]));
    });
  }

  close(): void {
    this.disconnect(new Error('QEMU 调试连接已关闭'));
    this.socket.destroy();
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.emit('disconnect', error);
  }

  private send(payload: string): void {
    const bytes = Buffer.from(payload, 'ascii');
    const checksum = bytes
      .reduce((sum, byte) => (sum + byte) & 255, 0)
      .toString(16)
      .padStart(2, '0');
    this.lastPacket = Buffer.concat([Buffer.from('$'), bytes, Buffer.from(`#${checksum}`)]);
    this.retries = 0;
    this.socket.write(this.lastPacket);
  }

  private receive(data: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, data]);
    if (this.incoming.length > 4 * 1024 * 1024) {
      this.disconnect(new Error('QEMU 调试数据包过大'));
      this.socket.destroy();
      return;
    }
    while (this.incoming.length) {
      const first = this.incoming[0];
      if (first !== 36) {
        this.incoming = this.incoming.subarray(1);
        if (first === 45 && this.lastPacket) {
          if (++this.retries > 3) {
            this.close();
            return;
          }
          this.socket.write(this.lastPacket);
        }
        continue;
      }
      const end = this.incoming.indexOf(35, 1);
      if (end < 0 || this.incoming.length < end + 3) return;
      const encoded = this.incoming.subarray(1, end);
      const sum = encoded.reduce((value, byte) => (value + byte) & 255, 0);
      const checksum = this.incoming.subarray(end + 1, end + 3).toString('ascii');
      this.incoming = this.incoming.subarray(end + 3);
      if (!/^[0-9a-f]{2}$/i.test(checksum) || sum !== parseInt(checksum, 16)) {
        this.socket.write('-');
        continue;
      }
      this.socket.write('+');
      let response: string;
      try {
        response = decodePayload(encoded);
      } catch (error) {
        this.disconnect(error as Error);
        this.socket.destroy();
        return;
      }
      if (/^O(?:[0-9a-f]{2})*$/i.test(response)) {
        const output = Buffer.from(response.slice(1), 'hex').toString('utf8');
        this.pending?.console.push(output);
        this.emit('output', output);
        continue;
      }
      // 无挂起请求时，T/S 是 continue/step 或 Ctrl-C 的异步回复。
      if (/^[TS][0-9a-f]{2}/i.test(response) && !this.pending?.expectsStop) {
        this.emit('stop', response);
        continue;
      }
      if (/^[WX][0-9a-f]{2}/i.test(response) && !this.pending?.expectsStop) {
        this.emit('exit', response);
        continue;
      }
      const pending = this.pending;
      if (pending) {
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (/^E[0-9a-fA-F]{2}$/.test(response)) pending.reject(new Error(`QEMU 调试请求失败：${response}`));
        else pending.resolve(pending.console.length ? pending.console.join('') : response);
      }
    }
  }
}

/** 转义与 RLE 都属于线上编码，校验和必须在解码前计算。 */
