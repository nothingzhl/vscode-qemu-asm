import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { Project, Processes, qemuArguments } from '../core';
import { decodeRegisters, RegisterLayout, registerLayout, RspClient } from './rsp';

export type WatchAccess = 'read' | 'write' | 'readWrite';
export interface DataWatchpoint { address: number; size: 1 | 2 | 4; access: WatchAccess }
export interface StoppedEvent {
  reason: 'entry' | 'breakpoint' | 'data breakpoint' | 'step' | 'pause' | 'exception';
  signal?: number;
  /** QEMU 报告的监视点起始地址；访问可以从范围外开始并与它重叠。 */
  dataAddress?: number;
  /** QEMU 实际回复的 watch / rwatch / awatch 类型。 */
  dataAccess?: WatchAccess;
}

/** 只负责一个单 CPU 的 QEMU 进程；源码映射由 DAP 适配器负责。 */
export class DebugRuntime extends EventEmitter {
  private readonly processes = new Processes();
  private client?: RspClient;
  private layout: RegisterLayout[] = [];
  private breakpoints = new Set<number>();
  private dataBreakpoints = new Map<string, DataWatchpoint>();
  private running = false;
  private stopping = false;
  private ended = false;
  private launched = false;
  private nextStop: StoppedEvent['reason'] = 'breakpoint';
  private breakpointStep?: { address: number; step: boolean; pause: boolean; awaiting: boolean };
  private steppedWatch = false;
  private watchTrapCheck?: { registers: Record<string, number>; step: boolean };
  private pauseRequested = false;
  private physicalStop = true;
  private stopPackets: Promise<void> = Promise.resolve();
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
        this.physicalStop = true;
        this.stopPackets = this.stopPackets.then(() => this.handleStop(packet)).catch(error => {
          this.finish(error as Error);
          void this.dispose();
        });
      });
      await this.client.command('qSupported:multiprocess+;qXfer:features:read+;xmlRegisters=i386');
      const target = await this.readTarget('target.xml');
      if (!/<architecture>\s*i386\s*<\/architecture>/.test(target)) throw new Error('当前调试仅支持 QEMU i386 32 位寄存器布局，不支持 64 位 CPU');
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
    const previous = new Set(this.breakpoints);
    const update = async (target: Set<number>) => {
      for (const address of this.breakpoints) {
        if (target.has(address)) continue;
        this.expectOK(await client.command(`z1,${address.toString(16)},1`), '移除硬件断点');
        this.breakpoints.delete(address);
      }
      for (const address of target) {
        if (this.breakpoints.has(address)) continue;
        this.expectOK(await client.command(`Z1,${address.toString(16)},1`), '设置硬件断点');
        this.breakpoints.add(address);
      }
    };
    try { await update(desired); }
    catch (error) {
      try { await update(previous); }
      catch (rollback) {
        const failure = new Error(`硬件断点设置失败且无法恢复旧设置：${(rollback as Error).message}`);
        this.finish(failure);
        await this.dispose();
        throw failure;
      }
      throw error;
    }
  }

  /** 整批替换数据断点。失败时恢复旧集合，不把半完成的设置留给适配器。 */
  async setDataBreakpoints(points: DataWatchpoint[]): Promise<void> {
    const client = this.requireStopped();
    if (points.length > 16) throw new Error('最多同时设置 16 个数据断点');
    const desired = new Map<string, DataWatchpoint>();
    for (const point of points) {
      this.validateAddress(point.address);
      if (![1, 2, 4].includes(point.size) || point.address + point.size > 0x100000000) throw new Error('数据断点长度必须是 1、2 或 4 字节且地址不能溢出');
      if (!['read', 'write', 'readWrite'].includes(point.access)) throw new Error('数据断点访问类型必须是 read、write 或 readWrite');
      const copy = { ...point };
      desired.set(watchKey(copy), copy);
    }
    const previous = new Map(this.dataBreakpoints);
    const update = async (target: Map<string, DataWatchpoint>) => {
      for (const [key, point] of this.dataBreakpoints) {
        if (target.has(key)) continue;
        this.expectOK(await client.command(watchCommand(point, false)), '移除数据断点');
        this.dataBreakpoints.delete(key);
      }
      for (const [key, point] of target) {
        if (this.dataBreakpoints.has(key)) continue;
        this.expectOK(await client.command(watchCommand(point, true)), '设置数据断点');
        this.dataBreakpoints.set(key, point);
      }
    };
    try { await update(desired); }
    catch (error) {
      try { await update(previous); }
      catch (rollback) {
        const failure = new Error(`数据断点设置失败且无法恢复旧设置：${(rollback as Error).message}`);
        this.finish(failure);
        await this.dispose();
        throw failure;
      }
      throw error;
    }
  }

  async resume(step = false): Promise<void> {
    const client = this.requireStopped();
    const registers = await this.registers();
    const address = instructionAddress(registers);
    this.watchTrapCheck = this.steppedWatch ? { registers, step } : undefined;
    this.steppedWatch = false;
    this.pauseRequested = false;
    this.nextStop = step ? 'step' : 'breakpoint';
    if (this.breakpoints.has(address)) {
      // QEMU 的 Z1 在 c 后会原地再次触发，先临时移除并完成一条指令。
      this.expectOK(await client.command(`z1,${address.toString(16)},1`), '临时移除硬件断点');
      this.breakpointStep = { address, step, pause: false, awaiting: true };
    }
    this.running = true;
    this.physicalStop = false;
    try { await client.resume(this.breakpointStep ? true : step); }
    catch (error) { this.running = false; throw error; }
  }

  async pause(): Promise<void> {
    const client = this.requireClient();
    if (!this.running) return;
    this.pauseRequested = true;
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
        if (!this.physicalStop && (!this.breakpointStep || this.breakpointStep.awaiting)) client.interrupt();
      } catch (error) { cleanup(); reject(error); }
    });
  }

  async registers(): Promise<Record<string, number>> {
    return this.readRegisters(this.requireStopped());
  }

  private async readRegisters(client: RspClient): Promise<Record<string, number>> {
    const registers = decodeRegisters(await client.command('g'), this.layout);
    const monitor = await client.command(`qRcmd,${Buffer.from('info registers').toString('hex')}`);
    Object.assign(registers, monitorRegisters(monitor));
    cpuMode(registers);
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

  private async handleStop(packet: string): Promise<void> {
    if (this.stopping || !this.running) return;
    this.physicalStop = true;
    const event = stoppedEvent(packet, this.nextStop);
    const check = this.watchTrapCheck;
    this.watchTrapCheck = undefined;
    // TCG 的单步若先命中 watch，下一次 resume 可能先交付残留的单步 trap。
    // 只忽略一次完全无寄存器进展的普通 SIGTRAP；LOOP/REP 的真实单步仍可见。
    if (check && event.signal === 5 && event.reason !== 'data breakpoint' && !this.pauseRequested && !this.breakpointStep?.pause) {
      const current = await this.readRegisters(this.requireClient());
      if (Object.keys(check.registers).every(name => current[name] === check.registers[name]) &&
          Object.keys(current).every(name => current[name] === check.registers[name]) &&
          !this.pauseRequested && !this.breakpointStep?.pause) {
        const internal = this.breakpointStep;
        if (internal) internal.awaiting = true;
        this.physicalStop = false;
        await this.requireClient().resume(internal ? true : check.step);
        return;
      }
    }
    const internal = this.breakpointStep;
    if (internal) {
      internal.awaiting = false;
      await this.afterBreakpointStep(packet, internal);
      return;
    }
    this.running = false;
    if (event.reason !== 'data breakpoint' && event.signal === 5 && this.pauseRequested) event.reason = 'pause';
    this.pauseRequested = false;
    if (event.reason === 'data breakpoint' && this.nextStop === 'step') this.steppedWatch = true;
    this.emit('stopped', event);
  }

  private async afterBreakpointStep(packet: string, internal: { address: number; step: boolean; pause: boolean }): Promise<void> {
    if (this.stopping) return;
    const client = this.requireClient();
    this.expectOK(await client.command(`Z1,${internal.address.toString(16)},1`), '恢复硬件断点');
    if (this.stopping) return;
    this.breakpointStep = undefined;
    const event = stoppedEvent(packet, 'step');
    if (event.reason === 'data breakpoint' || internal.step || internal.pause || event.signal !== 5) {
      this.running = false;
      this.pauseRequested = false;
      if (event.reason === 'data breakpoint') this.steppedWatch = true;
      if (event.reason !== 'data breakpoint' && internal.pause && event.signal === 5) event.reason = 'pause';
      this.emit('stopped', event);
      return;
    }
    this.running = true;
    this.physicalStop = false;
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

function watchKey(point: DataWatchpoint): string { return `${point.access}:${point.address}:${point.size}`; }
function watchCommand(point: DataWatchpoint, insert: boolean): string {
  const type = { write: 2, read: 3, readWrite: 4 }[point.access];
  return `${insert ? 'Z' : 'z'}${type},${point.address.toString(16)},${point.size.toString(16)}`;
}

/** 监视点字段优先于单步/暂停意图，避免把真实内存访问误当成内部停止吞掉。 */
export function stoppedEvent(packet: string, expected: StoppedEvent['reason']): StoppedEvent {
  const signal = parseInt(packet.slice(1, 3), 16);
  const match = /(?:^T[0-9a-f]{2}|;)(watch|rwatch|awatch):([0-9a-f]+);/i.exec(packet);
  if (match) {
    const address = parseInt(match[2], 16);
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) throw new Error('QEMU 返回无效的数据断点地址');
    const access: Record<string, WatchAccess> = { watch: 'write', rwatch: 'read', awatch: 'readWrite' };
    return { reason: 'data breakpoint', signal, dataAddress: address, dataAccess: access[match[1].toLowerCase()] };
  }
  return { reason: signal === 5 ? expected : signal === 2 ? 'pause' : 'exception', signal };
}

/** 使用实际 CS 隐藏 base；重置向量保持在 0xfffffff0，不会误映射成引导源码。 */
export function realModeAddress(registers: Record<string, number>): number {
  if (!Number.isInteger(registers.cs) || !Number.isInteger(registers.eip)) throw new Error('缺少 CS/EIP 寄存器');
  validateRealModeRegisters(registers);
  return ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + (registers.eip & 0xffff)) >>> 0;
}

export type CpuMode = 'real16' | 'protected16' | 'protected32';

/** CR0.PE 改变后仍使用实际 CS 缓存；远跳转加载 CS.D 后才切换到 32 位指令。 */
export function cpuMode(registers: Record<string, number>): CpuMode {
  if (registers.smm) throw new Error('当前调试不支持系统管理模式（SMM）');
  if (registers.eflags !== undefined && registers.eflags & (1 << 17)) throw new Error('当前调试不支持虚拟 8086 模式');
  if (registers.efer !== undefined && registers.efer & (1 << 10)) throw new Error('当前调试不支持 64 位长模式（EFER.LMA）');
  if (registers.cr0 !== undefined && registers.cr0 & 0x80000000) throw new Error('当前调试不支持分页（CR0.PG=1），请在关闭分页时调试');
  if (!((registers.cr0 ?? 0) & 1)) {
    validateRealModeRegisters(registers);
    return 'real16';
  }
  const flags = registers.cs_flags;
  if (!Number.isInteger(flags) || !Number.isInteger(registers.cs_base) || !Number.isInteger(registers.cs_limit)) throw new Error('缺少保护模式 CS 段缓存，无法安全定位指令');
  if (flags & (1 << 21)) throw new Error('当前调试不支持 64 位代码段（CS.L）');
  // QEMU 的段缓存 flags 中，access byte 位于第 8 到 15 位。
  if ((flags & 0x9800) !== 0x9800) throw new Error('CS 必须是已存在的可执行代码段（P/S/Executable）');
  return flags & (1 << 22) ? 'protected32' : 'protected16';
}

/** 保护模式使用完整 EIP；CS.D 只决定默认操作数宽度，不限制指令地址到 64 KiB。 */
export function instructionAddress(registers: Record<string, number>): number {
  if (!Number.isInteger(registers.cs) || !Number.isInteger(registers.eip)) throw new Error('缺少 CS/EIP 寄存器');
  const mode = cpuMode(registers);
  const offset = mode === 'real16' ? registers.eip & 0xffff : registers.eip >>> 0;
  return ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + offset) >>> 0;
}

/** 栈地址宽度以 SS.B 判断，不能用 CS.D 推断刚进入保护模式时的栈宽。 */
export function stackWidth(registers: Record<string, number>): 2 | 4 {
  const mode = cpuMode(registers);
  if (mode === 'real16') return 2;
  if (!Number.isInteger(registers.ss_flags) || !Number.isInteger(registers.ss_base)) throw new Error('缺少保护模式 SS 段缓存，无法安全定位栈');
  return registers.ss_flags & (1 << 22) ? 4 : 2;
}

/** offset 可指定 BP/ESP 链中的栈偏移，仍按当前 SS 的地址宽度回绕。 */
export function stackAddress(registers: Record<string, number>, offset = registers.esp): number {
  if (!Number.isInteger(registers.ss) || !Number.isInteger(offset)) throw new Error('缺少 SS/ESP 寄存器');
  const width = stackWidth(registers);
  const pointer = width === 4 ? offset >>> 0 : offset & 0xffff;
  return ((registers.ss_base ?? (registers.ss & 0xffff) * 16) + pointer) >>> 0;
}

/** monitor 补充 g 包未描述的控制寄存器与段缓存。 */
export function monitorRegisters(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  const cr0 = /\bCR0=([0-9a-f]+)/i.exec(text);
  if (!cr0) throw new Error('无法读取 CR0，不能确认 CPU 执行模式');
  values.cr0 = parseInt(cr0[1], 16);
  for (const name of ['cr2', 'cr3', 'cr4', 'efer']) {
    const value = new RegExp(`\\b${name}=([0-9a-f]+)`, 'i').exec(text);
    if (value) values[name] = parseInt(value[1], 16);
  }
  const smm = /\bSMM=(\d+)/.exec(text);
  if (smm) values.smm = Number(smm[1]);
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
    const segment = new RegExp(`^${name.toUpperCase()}\\s*=([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (!segment) throw new Error(`无法读取 ${name.toUpperCase()} 段缓存，不能安全定位调试地址`);
    values[name] = parseInt(segment[1], 16);
    values[`${name}_base`] = parseInt(segment[2], 16);
    values[`${name}_limit`] = parseInt(segment[3], 16);
    values[`${name}_flags`] = parseInt(segment[4], 16);
  }
  // Older monitor fixtures need not expose these; only the inspector requires them.
  for (const [name, prefix] of [['GDT', 'gdtr'], ['IDT', 'idtr']]) {
    const table = new RegExp(`^${name}\\s*=\\s*([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (table) { values[`${prefix}_base`] = parseInt(table[1], 16); values[`${prefix}_limit`] = parseInt(table[2], 16); }
  }
  for (const name of ['ldt', 'tr']) {
    const segment = new RegExp(`^${name.toUpperCase()}\\s*=\\s*([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (!segment) continue;
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
