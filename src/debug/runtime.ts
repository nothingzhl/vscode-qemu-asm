import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { Project, Processes, qemuArguments } from '../core';
import { decodeRegisters, RegisterLayout, registerLayout, RspClient } from './rsp';

export interface StoppedEvent { reason: 'entry' | 'breakpoint' | 'step' | 'pause' | 'exception'; signal?: number }

/** 只负责一个单 CPU 的 QEMU 进程；源码映射由 DAP 适配器负责。 */
export class DebugRuntime extends EventEmitter {
  private readonly processes = new Processes();
  private client?: RspClient;
  private layout: RegisterLayout[] = [];
  private breakpoints = new Set<number>();
  private running = false;
  private stopping = false;
  private ended = false;
  private launched = false;
  private nextStop: StoppedEvent['reason'] = 'breakpoint';
  private breakpointStep?: { address: number; step: boolean; pause: boolean; awaiting: boolean };
  private disposal?: Promise<void>;

  constructor(private readonly project: Project, private readonly log: (text: string) => void, private readonly extraArgs: readonly string[] = []) { super(); }

  async launch(): Promise<void> {
    if (this.launched || this.stopping) throw new Error('调试运行时不能重复启动');
    this.launched = true;
    for (let index = 0; index < this.project.qemuArgs.length; index += 2) {
      if (this.project.qemuArgs[index] === '-smp' && this.project.qemuArgs[index + 1] !== '1') throw new Error('当前调试仅支持单 CPU，请把 -smp 设置为 1');
    }
    try {
      const port = await freePort();
      const args = [...qemuArguments(this.project), ...this.extraArgs, '-S', '-gdb', `tcp:127.0.0.1:${port}`];
      const process = this.processes.start(this.project.qemu, args, this.project.root, this.log);
      let processError: Error | undefined;
      void process.done.then(() => {
        processError = new Error('QEMU 已退出');
        if (!this.stopping) { this.finish(processError); void this.dispose(); }
      }, error => {
        processError = error as Error;
        if (!this.stopping) { this.finish(processError); void this.dispose(); }
      });
      await process.ready;
      const deadline = Date.now() + 8000;
      while (!this.client) {
        if (this.stopping || processError) throw processError ?? new Error('调试启动已取消');
        try { this.client = await RspClient.connect(port, '127.0.0.1', 400); }
        catch (error) {
          if (Date.now() >= deadline) throw new Error(`无法连接 QEMU 调试接口：${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
      }
      if (this.stopping) { this.client.close(); throw new Error('调试启动已取消'); }
      this.client.on('disconnect', (error: Error) => {
        if (!this.stopping) { this.finish(error); void this.dispose(); }
      });
      this.client.on('exit', () => { this.finish(); void this.dispose(); });
      this.client.on('stop', (packet: string) => {
        this.running = false;
        const internal = this.breakpointStep;
        if (internal) {
          internal.awaiting = false;
          this.running = true;
          void this.afterBreakpointStep(packet, internal).catch(error => {
            this.finish(error as Error);
            void this.dispose();
          });
          return;
        }
        const signal = parseInt(packet.slice(1, 3), 16);
        const reason = signal === 5 ? this.nextStop : signal === 2 ? 'pause' : 'exception';
        this.emit('stopped', { reason, signal } satisfies StoppedEvent);
      });
      await this.client.command('qSupported:multiprocess+;qXfer:features:read+;xmlRegisters=i386');
      const target = await this.readTarget('target.xml');
      if (!/<architecture>\s*i386\s*<\/architecture>/.test(target)) throw new Error('当前调试仅支持 QEMU i386 32 位寄存器布局与 16 位实模式');
      this.layout = registerLayout(target);
      const names = new Set(this.layout.map(register => register.name));
      for (const name of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
        if (!names.has(name)) throw new Error(`QEMU 寄存器描述缺少 ${name}`);
      }
      const stopped = await this.client.command('?');
      if (!/^[TS][0-9a-f]{2}/i.test(stopped)) throw new Error('QEMU 没有在启动时暂停');
      await this.registers();
      this.emit('stopped', { reason: 'entry' } satisfies StoppedEvent);
    } catch (error) { this.finish(error as Error); await this.dispose(); throw error; }
  }

  async setBreakpoints(addresses: number[]): Promise<void> {
    const client = this.requireStopped();
    for (const address of addresses) this.validateAddress(address);
    const desired = new Set(addresses);
    for (const address of this.breakpoints) {
      if (desired.has(address)) continue;
      this.expectOK(await client.command(`z1,${address.toString(16)},1`), '移除硬件断点');
      this.breakpoints.delete(address);
    }
    for (const address of desired) {
      if (this.breakpoints.has(address)) continue;
      this.expectOK(await client.command(`Z1,${address.toString(16)},1`), '设置硬件断点');
      this.breakpoints.add(address);
    }
  }

  async resume(step = false): Promise<void> {
    const client = this.requireStopped();
    const registers = await this.registers();
    const address = realModeAddress(registers);
    this.nextStop = step ? 'step' : 'breakpoint';
    if (this.breakpoints.has(address)) {
      // QEMU 的 Z1 在 c 后会原地再次触发，先临时移除并完成一条指令。
      this.expectOK(await client.command(`z1,${address.toString(16)},1`), '临时移除硬件断点');
      this.breakpointStep = { address, step, pause: false, awaiting: true };
    }
    this.running = true;
    try { await client.resume(this.breakpointStep ? true : step); }
    catch (error) { this.running = false; throw error; }
  }

  async pause(): Promise<void> {
    const client = this.requireClient();
    if (!this.running) return;
    if (this.breakpointStep) this.breakpointStep.pause = true;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('stopped', stopped); this.off('terminated', terminated); };
      const stopped = () => { cleanup(); resolve(); };
      const terminated = () => { cleanup(); reject(new Error('暂停前 QEMU 已退出')); };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error('等待 QEMU 暂停超时');
        this.finish(error);
        void this.dispose();
        reject(error);
      }, 5000);
      this.once('stopped', stopped);
      this.once('terminated', terminated);
      try {
        if (!this.breakpointStep || this.breakpointStep.awaiting) client.interrupt();
      } catch (error) { cleanup(); reject(error); }
    });
  }

  async registers(): Promise<Record<string, number>> {
    const client = this.requireStopped();
    const registers = decodeRegisters(await client.command('g'), this.layout);
    const monitor = await client.command(`qRcmd,${Buffer.from('info registers').toString('hex')}`);
    Object.assign(registers, monitorRegisters(monitor));
    validateRealModeRegisters(registers);
    return registers;
  }

  async readMemory(address: number, count: number): Promise<Buffer> {
    const client = this.requireStopped();
    this.validateAddress(address);
    if (!Number.isSafeInteger(count) || count < 0 || count > 65536 || address + count > 0x100000000) throw new Error('内存读取长度必须在 0 到 65536 之间且地址不能溢出');
    if (!count) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < count; offset += 512) {
      const size = Math.min(512, count - offset);
      const response = await client.command(`m${(address + offset).toString(16)},${size.toString(16)}`);
      if (!/^(?:[0-9a-f]{2})+$/i.test(response) || response.length !== size * 2) throw new Error('QEMU 返回不完整的内存数据');
      chunks.push(Buffer.from(response, 'hex'));
    }
    return Buffer.concat(chunks);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopping = true;
    this.running = false;
    this.client?.close();
    this.disposal = this.processes.dispose().then(() => this.finish());
    return this.disposal;
  }

  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('terminated', error ? { error: error.message } : {});
  }

  private async afterBreakpointStep(packet: string, internal: { address: number; step: boolean; pause: boolean }): Promise<void> {
    if (this.stopping) return;
    const client = this.requireClient();
    this.expectOK(await client.command(`Z1,${internal.address.toString(16)},1`), '恢复硬件断点');
    if (this.stopping) return;
    this.breakpointStep = undefined;
    const signal = parseInt(packet.slice(1, 3), 16);
    if (internal.step || internal.pause || signal !== 5) {
      this.running = false;
      const reason = internal.pause || signal === 2 ? 'pause' : signal === 5 ? 'step' : 'exception';
      this.emit('stopped', { reason, signal } satisfies StoppedEvent);
      return;
    }
    this.running = true;
    await client.resume();
  }

  private requireClient(): RspClient {
    if (!this.client || this.stopping) throw new Error('QEMU 调试会话尚未启动或已经结束');
    return this.client;
  }

  private requireStopped(): RspClient {
    const client = this.requireClient();
    if (this.running) throw new Error('请先暂停 CPU，再读取寄存器、内存或修改断点');
    return client;
  }

  private validateAddress(address: number): void {
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) throw new Error('调试地址必须是有效的 32 位无符号整数');
  }

  private expectOK(response: string, operation: string): void {
    if (response !== 'OK') throw new Error(`QEMU 不支持${operation}：${response || '空回复'}`);
  }

  private async readTarget(annex: string, seen = new Set<string>()): Promise<string> {
    if (!/^[\w.-]+$/.test(annex) || seen.has(annex) || seen.size >= 20) throw new Error('QEMU target XML 引用无效');
    seen.add(annex);
    let result = '';
    while (true) {
      const response = await this.requireClient().command(`qXfer:features:read:${annex}:${Buffer.byteLength(result).toString(16)},1000`);
      if (!/^[ml]/.test(response)) throw new Error('QEMU 不支持 target XML，无法安全解析寄存器');
      result += response.slice(1);
      if (result.length > 1024 * 1024) throw new Error('QEMU target XML 过大');
      if (response[0] === 'l') break;
      if (response.length === 1) throw new Error('QEMU target XML 读取没有进展');
    }
    for (const match of [...result.matchAll(/<xi:include\s+href=["']([^"']+)["'][^>]*\/>/g)]) {
      result = result.replace(match[0], await this.readTarget(match[1], seen));
    }
    return result;
  }
}

/** 使用实际 CS 隐藏 base；重置向量保持在 0xfffffff0，不会误映射成引导源码。 */
export function realModeAddress(registers: Record<string, number>): number {
  if (!Number.isInteger(registers.cs) || !Number.isInteger(registers.eip)) throw new Error('缺少 CS/EIP 寄存器');
  validateRealModeRegisters(registers);
  return ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + (registers.eip & 0xffff)) >>> 0;
}

/** monitor 补充 g 包未描述的段缓存，避免把 unreal/big-real 模式显示成普通实模式。 */
export function monitorRegisters(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  const cr0 = /\bCR0=([0-9a-f]+)/i.exec(text);
  if (!cr0) throw new Error('无法读取 CR0，不能确认 CPU 是否处于实模式');
  values.cr0 = parseInt(cr0[1], 16);
  const smm = /\bSMM=(\d+)/.exec(text);
  if (smm) values.smm = Number(smm[1]);
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
    const segment = new RegExp(`^${name.toUpperCase()}\\s*=([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (!segment) throw new Error(`无法读取 ${name.toUpperCase()} 段缓存，不能安全定位实模式地址`);
    values[name] = parseInt(segment[1], 16);
    values[`${name}_base`] = parseInt(segment[2], 16);
    values[`${name}_limit`] = parseInt(segment[3], 16);
    values[`${name}_flags`] = parseInt(segment[4], 16);
  }
  return values;
}

export function validateRealModeRegisters(registers: Record<string, number>): void {
  if (registers.cr0 !== undefined && registers.cr0 & 1 || registers.eflags !== undefined && registers.eflags & (1 << 17)) {
    throw new Error('当前调试仅支持 16 位实模式；CPU 已进入保护模式或虚拟 8086 模式');
  }
  if (registers.smm) throw new Error('当前调试不支持系统管理模式（SMM）');
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
    const selector = registers[name];
    const base = registers[`${name}_base`];
    const limit = registers[`${name}_limit`];
    const flags = registers[`${name}_flags`];
    const resetCS = name === 'cs' && selector === 0xf000 && base === 0xffff0000 && registers.eip === 0xfff0;
    if (base !== undefined && base !== (selector & 0xffff) * 16 && !resetCS || limit !== undefined && limit !== 0xffff || flags !== undefined && flags & ((1 << 22) | (1 << 21))) {
      throw new Error(`当前调试仅支持标准 16 位实模式；${name.toUpperCase()} 段缓存属于尚不支持的 unreal/big-real 模式`);
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配调试端口')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
