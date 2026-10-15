import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { QmpClient, QmpError } from './qmp';

export interface ScreenFrame { png: Buffer; width: number; height: number }
export interface ScreenStatus { state: 'connecting' | 'connected' | 'error' | 'stopped'; message?: string }
const MAX_PIXELS = 4096 * 2160;
const MAX_PPM_BYTES = MAX_PIXELS * 3 + 4096;
const KEY_CODES = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  'esc', 'minus', 'equal', 'backspace', 'tab', 'bracket_left', 'bracket_right', 'ret', 'ctrl',
  'semicolon', 'apostrophe', 'grave_accent', 'shift', 'backslash', 'comma', 'dot', 'slash',
  'shift_r', 'kp_multiply', 'alt', 'spc', 'caps_lock', 'num_lock', 'scroll_lock', 'kp_divide',
  'kp_enter', 'ctrl_r', 'alt_r', 'home', 'up', 'pgup', 'left', 'right', 'end', 'down', 'pgdn',
  'insert', 'delete', 'meta_l', 'meta_r', 'kp_decimal', ...Array.from({ length: 10 }, (_, i) => `kp_${i}`)
]);

/** Real VGA output from QEMU's display surface, independent of the debugger and CPU execution. */
export class QemuScreen extends EventEmitter {
  readonly args: string[];
  private client?: QmpClient;
  private connectPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private readonly abort = new AbortController();
  private pollTimer?: NodeJS.Timeout;
  private captureQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private failed = false;

  private constructor(private readonly directory: string, private readonly port: number) {
    super();
    // The process manager already selects -display none for both run and debug.
    this.args = ['-qmp', `tcp:127.0.0.1:${port},server=on,wait=off`];
  }

  static async create(): Promise<QemuScreen> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu-asm-screen-'));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配 QMP 本地端口')); return; }
          server.close(error => error ? reject(error) : resolve(address.port));
        });
      });
      return new QemuScreen(directory, port);
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('QEMU 显示器已停止'));
    this.connectPromise ??= this.open();
    return this.connectPromise;
  }

  private async open(): Promise<void> {
    this.emit('status', { state: 'connecting' } satisfies ScreenStatus);
    const deadline = Date.now() + 6000;
    let lastError: unknown = new Error('未能连接 QEMU 显示器');
    while (!this.disposed && Date.now() < deadline) {
      try {
        const client = await QmpClient.connect(this.port, 1000, 3000, this.abort.signal);
        if (this.disposed) { client.close(); throw new Error('QEMU 显示器已停止'); }
        this.client = client;
        client.on('disconnect', error => this.fail(error));
        this.emit('status', { state: 'connected' } satisfies ScreenStatus);
        this.poll();
        return;
      } catch (error) {
        lastError = error;
        if (this.disposed) break;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 100);
          this.abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
    if (!this.disposed) this.fail(lastError);
    throw lastError;
  }

  capture(): Promise<ScreenFrame> {
    const operation = this.captureQueue.then(async () => {
      if (this.disposed || this.failed || !this.client) throw new Error('QEMU 显示器未连接');
      const filename = path.join(this.directory, 'screen.ppm');
      await this.client.command('screendump', { filename });
      if (this.disposed) throw new Error('QEMU 显示器已停止');
      const file = await fs.open(filename, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_PPM_BYTES) throw new Error('QEMU 屏幕图像过大');
        return ppmToPng(await file.readFile());
      } finally { await file.close(); }
    });
    this.captureQueue = operation.catch(() => undefined);
    return operation;
  }

  async sendKey(key: string): Promise<void> {
    const keys = key.split('-');
    if (!key || keys.length > 4 || new Set(keys).size !== keys.length || keys.some(value => !KEY_CODES.has(value))) throw new Error('不支持的模拟键盘按键');
    if (this.disposed || this.failed || !this.client) throw new Error('QEMU 显示器未连接');
    await this.client.command('send-key', { keys: keys.map(data => ({ type: 'qcode', data })), 'hold-time': 80 });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    // Publish the shared promise before emitting events, whose handlers may dispose again.
    this.disposePromise = Promise.resolve().then(async () => {
      await this.connectPromise?.catch(() => undefined);
      await this.captureQueue;
      await fs.rm(this.directory, { recursive: true, force: true });
    });
    this.abort.abort();
    clearTimeout(this.pollTimer);
    this.client?.close();
    this.emit('status', { state: 'stopped' } satisfies ScreenStatus);
    return this.disposePromise;
  }

  private poll(): void {
    if (this.disposed || this.failed) return;
    void this.capture().then(frame => {
      if (!this.disposed && !this.failed) this.emit('frame', frame);
    }).catch(error => {
      // With -S, VGA may not yet exist. Keep polling until BIOS initializes it.
      if (!(error instanceof QmpError && /(?:no (?:console|display)|display (?:is )?not|not initialized|no graphic)/i.test(error.message))) this.fail(error);
    }).finally(() => {
      if (!this.disposed && !this.failed) this.pollTimer = setTimeout(() => this.poll(), 200);
    });
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    clearTimeout(this.pollTimer);
    this.client?.close();
    this.emit('status', { state: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ScreenStatus);
  }
}

/** P6 permits comments between header tokens; consume only the raster separator after maxval. */
export function ppmToPng(ppm: Buffer): ScreenFrame {
  if (ppm.length > MAX_PPM_BYTES) throw new Error('QEMU 屏幕图像过大');
  let offset = 0;
  const whitespace = (byte: number) => byte === 32 || (byte >= 9 && byte <= 13);
  const token = (): string => {
    for (;;) {
      while (offset < ppm.length && whitespace(ppm[offset])) offset++;
      if (ppm[offset] !== 35) break;
      while (offset < ppm.length && ppm[offset] !== 10 && ppm[offset] !== 13) offset++;
    }
    const start = offset;
    while (offset < ppm.length && !whitespace(ppm[offset]) && ppm[offset] !== 35) offset++;
    if (offset === start || offset - start > 64) throw new Error('无效的 QEMU PPM 头');
    return ppm.subarray(start, offset).toString('ascii');
  };
  if (token() !== 'P6') throw new Error('QEMU 未返回 P6 屏幕图像');
  const widthToken = token(); const heightToken = token(); const maximum = token();
  if (!/^[1-9]\d*$/.test(widthToken) || !/^[1-9]\d*$/.test(heightToken) || maximum !== '255') throw new Error('无效的 QEMU PPM 尺寸或颜色深度');
  const width = Number(widthToken); const height = Number(heightToken);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw new Error('QEMU 屏幕尺寸过大');
  if (!whitespace(ppm[offset])) throw new Error('QEMU PPM 缺少像素分隔符');
  const separator = ppm[offset++];
  if (separator === 13 && ppm[offset] === 10) offset++;
  const stride = width * 3;
  if (ppm.length - offset !== stride * height) throw new Error('QEMU PPM 像素数据长度不符');
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    ppm.copy(raw, y * (stride + 1) + 1, offset + y * stride, offset + (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  return { png, width, height };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}
