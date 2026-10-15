import { EventEmitter } from 'node:events';
import * as net from 'node:net';

/** QEMU 的 GDB Remote Serial Protocol；所有请求串行，停止通知异步到达。 */
export class RspClient extends EventEmitter {
  private incoming = Buffer.alloc(0);
  private pending?: { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; console: string[]; expectsStop: boolean };
  private queue: Promise<unknown> = Promise.resolve();
  private lastPacket?: Buffer;
  private retries = 0;
  private closed = false;
  private constructor(private readonly socket: net.Socket, private readonly timeout: number) {
    super();
    socket.on('data', data => this.receive(data));
    socket.on('error', error => this.disconnect(error));
    socket.on('close', () => this.disconnect(new Error('QEMU 调试连接已断开')));
  }

  static connect(port: number, host = '127.0.0.1', timeout = 5000, commandTimeout = 5000): Promise<RspClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接 QEMU 调试接口超时')); }, timeout);
      const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
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
      try { return await action(command); }
      finally { active = false; await requests; }
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
      if (this.closed) { reject(new Error('QEMU 调试连接已关闭')); return; }
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
    return this.enqueue(() => { this.socket.write(Buffer.from([3])); });
  }

  close(): void { this.disconnect(new Error('QEMU 调试连接已关闭')); this.socket.destroy(); }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.emit('disconnect', error);
  }

  private send(payload: string): void {
    const bytes = Buffer.from(payload, 'ascii');
    const checksum = bytes.reduce((sum, byte) => (sum + byte) & 255, 0).toString(16).padStart(2, '0');
    this.lastPacket = Buffer.concat([Buffer.from('$'), bytes, Buffer.from(`#${checksum}`)]);
    this.retries = 0;
    this.socket.write(this.lastPacket);
  }

  private receive(data: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, data]);
    if (this.incoming.length > 4 * 1024 * 1024) { this.disconnect(new Error('QEMU 调试数据包过大')); this.socket.destroy(); return; }
    while (this.incoming.length) {
      const first = this.incoming[0];
      if (first !== 36) {
        this.incoming = this.incoming.subarray(1);
        if (first === 45 && this.lastPacket) {
          if (++this.retries > 3) { this.close(); return; }
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
      if (!/^[0-9a-f]{2}$/i.test(checksum) || sum !== parseInt(checksum, 16)) { this.socket.write('-'); continue; }
      this.socket.write('+');
      let response: string;
      try { response = decodePayload(encoded); }
      catch (error) { this.disconnect(error as Error); this.socket.destroy(); return; }
      if (/^O(?:[0-9a-f]{2})*$/i.test(response)) {
        const output = Buffer.from(response.slice(1), 'hex').toString('utf8');
        this.pending?.console.push(output);
        this.emit('output', output);
        continue;
      }
      // 无挂起请求时，T/S 是 continue/step 或 Ctrl-C 的异步回复。
      if (/^[TS][0-9a-f]{2}/i.test(response) && !this.pending?.expectsStop) { this.emit('stop', response); continue; }
      if (/^[WX][0-9a-f]{2}/i.test(response) && !this.pending?.expectsStop) { this.emit('exit', response); continue; }
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
export function decodePayload(encoded: Buffer): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const byte = encoded[i];
    if (byte === 125) {
      if (++i >= encoded.length) throw new Error('QEMU 返回不完整的 RSP 转义');
      bytes.push(encoded[i] ^ 32);
    } else if (byte === 42) {
      if (!bytes.length || ++i >= encoded.length || encoded[i] < 29) throw new Error('QEMU 返回无效的 RSP 重复编码');
      const previous = bytes[bytes.length - 1];
      for (let count = encoded[i] - 29; count > 0; count--) bytes.push(previous);
    } else bytes.push(byte);
  }
  return Buffer.from(bytes).toString('latin1');
}

export interface RegisterLayout { name: string; bits: number; offset: number; number: number }

/** 按 target XML 中的 regnum/位宽计算 g 数据包的字节偏移。 */
export function registerLayout(xml: string): RegisterLayout[] {
  const registers: RegisterLayout[] = [];
  let number = 0;
  let offset = 0;
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<reg\s+([^>]+)\/?\s*>/g)) {
    const attributes = new Map([...match[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(value => [value[1], value[2]]));
    const name = attributes.get('name');
    const bits = Number(attributes.get('bitsize'));
    const explicit = attributes.get('regnum');
    if (explicit !== undefined) number = Number(explicit);
    if (!name || !Number.isSafeInteger(bits) || bits <= 0 || bits % 8 || !Number.isSafeInteger(number) || number < 0) throw new Error('QEMU 返回无效的寄存器描述');
    if (registers.length && number !== registers[registers.length - 1].number + 1) throw new Error('QEMU 寄存器编号不连续，无法安全解析');
    registers.push({ name, bits, offset, number });
    offset += bits / 8;
    number++;
  }
  return registers;
}

export function decodeRegisters(hex: string, layout: RegisterLayout[]): Record<string, number> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('QEMU 返回无效的寄存器数据');
  const bytes = Buffer.from(hex, 'hex');
  const registers: Record<string, number> = {};
  for (const register of layout) {
    if (register.offset + register.bits / 8 > bytes.length) throw new Error('QEMU 寄存器数据长度不足');
    if (register.bits <= 32) registers[register.name] = bytes.readUIntLE(register.offset, register.bits / 8);
  }
  return registers;
}
