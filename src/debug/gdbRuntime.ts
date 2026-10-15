import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import { Project, Processes, qemuArguments } from '../core';
import { cpuMode, monitorRegisters } from './runtime';
import { MiClient, MiRecord, MiTuple, MiValue, miQuote } from './mi';

function tuple(value: MiValue | undefined): MiTuple | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** GDB CLI 的路径参数只做引号/反斜杠转义，不能使用 MI 的八进制字符串编码。 */
export function gdbPathQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('源码路径映射不支持换行或控制字符');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 只读验证文件布局，不将 ELF 内容装入客户机；客户机自己的 loader 负责装载。 */
export async function validateDebugElf(file: string): Promise<void> {
  // O_NONBLOCK 避免把误配置的 FIFO 当作 ELF 时在 open 阶段永久等待。
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 52) throw new Error('C 调试需要有效的 ELF32 文件');
    const read = async (position: number, length: number) => {
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || length > 8 * 1024 * 1024 || position + length > stat.size) throw new Error('ELF 节表范围无效');
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw new Error('ELF 文件读取不完整');
      return buffer;
    };
    const header = await read(0, 52);
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 1 || header[5] !== 1 || header[6] !== 1 || header.readUInt16LE(18) !== 3) throw new Error('C 调试仅支持小端 i386 ELF32，不支持 ELF64 或其他架构');
    if (header.readUInt16LE(16) !== 2) throw new Error('C 调试需要已链接的 ET_EXEC ELF32；暂不支持 PIE/ET_DYN 或未链接的目标文件');
    if (header.readUInt16LE(40) < 52) throw new Error('ELF 文件头无效');
    const sectionOffset = header.readUInt32LE(32);
    const sectionSize = header.readUInt16LE(46);
    const sectionCount = header.readUInt16LE(48);
    const namesIndex = header.readUInt16LE(50);
    if (sectionSize < 40 || sectionSize > 256 || !sectionCount || namesIndex <= 0 || namesIndex >= sectionCount) throw new Error('ELF 缺少可用的调试节表');
    const sections = await read(sectionOffset, sectionSize * sectionCount);
    const namesHeader = sections.subarray(namesIndex * sectionSize);
    const names = await read(namesHeader.readUInt32LE(16), namesHeader.readUInt32LE(20));
    let info = false;
    let line = false;
    for (let index = 0; index < sectionCount; index++) {
      const section = sections.subarray(index * sectionSize);
      const offset = section.readUInt32LE(0);
      if (offset >= names.length) throw new Error('ELF 节名称索引无效');
      const end = names.indexOf(0, offset);
      if (end < 0) throw new Error('ELF 节名称未结束');
      const name = names.toString('utf8', offset, end);
      if (section.readUInt32LE(4) === 8 || !section.readUInt32LE(20)) continue;
      if (section.readUInt32LE(16) + section.readUInt32LE(20) > stat.size) throw new Error('ELF 节范围超出文件');
      if (name === '.debug_info' || name === '.zdebug_info') info = true;
      if (name === '.debug_line' || name === '.zdebug_line') line = true;
    }
    if (!info || !line) throw new Error('ELF 缺少 DWARF 调试信息（.debug_info / .debug_line）；请使用 -g 编译并保留调试节');
  } finally { await handle.close(); }
}

/** C 模式只有 GDB 持有 QEMU GDB socket，避免两套 RSP 客户端争用目标。 */
export class GdbRuntime extends EventEmitter {
  private readonly processes = new Processes();
  private client?: MiClient;
  private launched = false;
  private active = false;
  private stopping = false;
  private ended = false;
  private running = false;
  private physicalStopped = true;
  private quietCommands = 0;
  private watchStopped = false;
  private watchResume?: { registers: Record<string, number>; command: string };
  private pauseRequested = false;
  private stops: Promise<void> = Promise.resolve();
  private registerNames: string[] = [];
  private initialStop: MiTuple = {};
  private disposal?: Promise<void>;

  constructor(private readonly project: Project, private readonly log: (text: string) => void, private readonly extraArgs: readonly string[] = []) { super(); }

  isRunning(): boolean { return this.running; }

  async launch(): Promise<void> {
    if (this.launched || this.stopping) throw new Error('C 调试运行时不能重复启动');
    this.launched = true;
    const debug = this.project.debug;
    if (!debug) throw new Error('C 源码调试需要配置 debug.elf 与 gdbPath');
    for (let index = 0; index < this.project.qemuArgs.length; index += 2) {
      if (this.project.qemuArgs[index] === '-smp' && this.project.qemuArgs[index + 1] !== '1') throw new Error('C 调试当前仅支持单 CPU，请把 -smp 设置为 1');
    }
    try {
      await validateDebugElf(debug.elf);
      if (this.stopping) throw new Error('C 调试启动已取消');
      const port = await freePort();
      const child = this.processes.start(this.project.qemu, [...qemuArguments(this.project), ...this.extraArgs, '-S', '-gdb', `tcp:127.0.0.1:${port}`], this.project.root, text => { this.log(text); this.emit('output', text); });
      let qemuError: Error | undefined;
      void child.done.then(() => {
        qemuError = new Error('QEMU 已退出');
        if (!this.stopping) { this.finish(qemuError); void this.dispose(); }
      }, error => {
        qemuError = error as Error;
        if (!this.stopping) { this.finish(qemuError); void this.dispose(); }
      });
      await child.ready;
      this.client = await MiClient.start(debug.gdb, ['--nx', '--nh', '--quiet', '--interpreter=mi2', '-iex', 'set auto-load off', '-iex', 'set debuginfod enabled off', '-iex', 'set may-call-functions off'], this.project.root);
      if (this.stopping) { await this.client.dispose(); throw new Error('C 调试启动已取消'); }
      const client = this.client;
      client.on('record', (record: MiRecord) => this.record(record));
      client.on('stderr', (text: string) => { this.log(text); this.emit('output', text); });
      client.on('stdout', (text: string) => { this.log(text); this.emit('output', text); });
      client.on('terminated', (error: Error) => { if (!this.stopping) { this.finish(error); void this.dispose(); } });
      for (const setting of ['auto-load off', 'debuginfod enabled off', 'may-call-functions off', 'pagination off', 'confirm off', 'mi-async on', 'language c', 'architecture i386', 'trust-readonly-sections off', 'stack-cache off', 'code-cache off', 'mem inaccessible-by-default off']) await client.command(`-gdb-set ${setting}`);
      await client.command(`-file-exec-and-symbols ${miQuote(debug.elf)}`);
      for (const [before, after] of Object.entries(debug.sourceMap ?? {})) {
        await client.command(`-interpreter-exec console ${miQuote(`set substitute-path ${gdbPathQuote(before)} ${gdbPathQuote(after)}`)}`);
      }
      const deadline = Date.now() + 8000;
      while (true) {
        if (this.stopping || qemuError) throw qemuError ?? new Error('C 调试启动已取消');
        try { await client.command(`-target-select remote 127.0.0.1:${port}`); break; }
        catch (error) {
          if (Date.now() >= deadline) throw new Error(`GDB 无法连接 QEMU：${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
      }
      const names = (await client.command('-data-list-register-names')).results['register-names'];
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('GDB 返回无效的寄存器名称');
      this.registerNames = names as string[];
      for (const name of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
        if (!this.registerNames.includes(name)) throw new Error(`当前 C 调试仅支持 i386 32 位寄存器布局，缺少 ${name}`);
      }
      this.running = false;
      await this.registers();
      this.active = true;
      this.emit('stopped', { ...this.initialStop, reason: 'entry' });
    } catch (error) { this.finish(error as Error); await this.dispose(); throw error; }
  }

  mi(command: string): Promise<MiRecord> {
    const client = this.requireClient();
    return client.transaction(async execute => {
      this.requireClient();
      const starts = /^-exec-(?:continue|step|next|finish|until|jump|run)(?:-instruction)?(?:\s|$)/.test(command);
      if (starts) {
        if (this.running) throw new Error('CPU 正在运行');
        this.watchResume = this.watchStopped ? { registers: await this.readRegisters(execute), command } : undefined;
        this.watchStopped = false;
        this.pauseRequested = false;
        this.running = true;
        this.physicalStopped = false;
      }
      try { return await execute(command); }
      catch (error) { if (starts) { this.running = false; this.physicalStopped = true; } throw error; }
    });
  }

  async console(command: string): Promise<string> {
    this.requireStopped();
    return (await this.mi(`-interpreter-exec console ${miQuote(command)}`)).console ?? '';
  }

  async registers(): Promise<Record<string, number>> {
    return this.requireStopped().transaction(async execute => {
      this.requireStopped();
      return this.readRegisters(execute);
    });
  }

  private async readRegisters(execute: (command: string) => Promise<MiRecord>): Promise<Record<string, number>> {
      const values = (await execute('-data-list-register-values x')).results['register-values'];
      if (!Array.isArray(values)) throw new Error('GDB 返回无效寄存器数据');
      const registers: Record<string, number> = {};
      for (const raw of values) {
        const row = tuple(raw);
        if (!row || typeof row.number !== 'string' || typeof row.value !== 'string' || !/^0x[\da-f]+$/i.test(row.value)) continue;
        const name = this.registerNames[Number(row.number)];
        const value = Number(row.value);
        if (name && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) registers[name] = value;
      }
      for (const name of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags']) {
        if (registers[name] === undefined) throw new Error(`GDB 无法读取 ${name} 寄存器`);
      }
      const monitor = await this.quietly(execute, `-interpreter-exec console ${miQuote('monitor info registers')}`);
      Object.assign(registers, monitorRegisters(monitor.console ?? ''));
      cpuMode(registers);
      return registers;
  }

  async readMemory(address: number, count: number): Promise<Buffer> {
    validateRange(address, count);
    return this.requireStopped().transaction(async execute => {
      this.requireStopped();
      const buffers: Buffer[] = [];
      for (let offset = 0; offset < count; offset += 1024) {
        const size = Math.min(1024, count - offset);
        const memory = (await execute(`-data-read-memory-bytes 0x${(address + offset).toString(16)} ${size}`)).results.memory;
        if (!Array.isArray(memory)) throw new Error('GDB 返回不完整的内存数据');
        let read = 0;
        for (const raw of memory) {
          const row = tuple(raw);
          if (!row || typeof row.begin !== 'string' || Number(row.begin) !== address + offset + read || typeof row.contents !== 'string' || !/^(?:[\da-f]{2})+$/i.test(row.contents)) throw new Error('GDB 返回不连续的内存数据');
          const buffer = Buffer.from(row.contents, 'hex');
          read += buffer.length;
          buffers.push(buffer);
        }
        if (read !== size) throw new Error('GDB 返回不完整的内存数据');
      }
      return Buffer.concat(buffers);
    });
  }

  async readPhysicalMemory(address: number, count: number): Promise<Buffer> {
    validateRange(address, count);
    return this.requireStopped().transaction(async execute => {
      this.requireStopped();
      if (!count) return Buffer.alloc(0);
      const packet = async (payload: string) => {
        const record = await this.quietly(execute, `-interpreter-exec console ${miQuote(`maintenance packet ${payload}`)}`);
        const response = /(?:^|\n)received:\s*"([^"\r\n]*)"/.exec(record.console ?? '');
        if (!response) throw new Error('GDB 没有返回 QEMU 维护包回复');
        return response[1];
      };
      const mode = await packet('qqemu.PhyMemMode');
      if (mode !== '0' && mode !== '1') throw new Error('当前 QEMU 不支持物理内存读取（qqemu.PhyMemMode）');
      try {
        if (await packet('Qqemu.PhyMemMode:1') !== 'OK') throw new Error('无法启用 QEMU 物理内存模式');
        const buffers: Buffer[] = [];
        for (let offset = 0; offset < count; offset += 512) {
          const size = Math.min(512, count - offset);
          const response = await packet(`m${(address + offset).toString(16)},${size.toString(16)}`);
          if (!/^(?:[\da-f]{2})+$/i.test(response) || response.length !== size * 2) throw new Error('QEMU 返回不完整的物理内存数据');
          buffers.push(Buffer.from(response, 'hex'));
        }
        return Buffer.concat(buffers);
      } finally {
        try { if (await packet('Qqemu.PhyMemMode:0') !== 'OK') throw new Error('QEMU 拒绝恢复虚拟地址模式'); }
        catch (error) {
          const failure = new Error(`物理内存读取后无法恢复虚拟地址模式，会话已关闭：${(error as Error).message}`);
          this.finish(failure);
          void this.dispose();
          throw failure;
        }
      }
    });
  }

  async resume(step = false): Promise<void> { await this.mi(step ? '-exec-step-instruction' : '-exec-continue'); }

  async pause(): Promise<void> {
    const client = this.requireClient();
    this.pauseRequested = true;
    if (!this.running) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('stopped', stopped); this.off('terminated', terminated); };
      const stopped = () => { cleanup(); resolve(); };
      const terminated = () => { cleanup(); reject(new Error('等待暂停时 C 调试会话已结束')); };
      const timer = setTimeout(() => { cleanup(); const error = new Error('等待 GDB 暂停超时，会话已关闭'); this.finish(error); void this.dispose(); reject(error); }, 5000);
      this.once('stopped', stopped);
      this.once('terminated', terminated);
      if (!this.physicalStopped) void client.command('-exec-interrupt').catch(error => { cleanup(); reject(error); });
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopping = true;
    this.running = false;
    this.disposal = Promise.allSettled([this.client?.dispose(), this.processes.dispose()]).then(() => { this.finish(); });
    return this.disposal;
  }

  private record(record: MiRecord): void {
    if (record.type === 'exec' && record.class === 'running') { this.running = true; this.physicalStopped = false; }
    if (record.type === 'exec' && record.class === 'stopped') {
      this.physicalStopped = true;
      if (typeof record.results.reason === 'string' && /^exited/.test(record.results.reason)) { this.finish(); void this.dispose(); return; }
      if (this.active) this.stops = this.stops.then(() => this.handleStop(record.results)).catch(error => { this.finish(error as Error); void this.dispose(); });
      else { this.running = false; this.initialStop = record.results; }
    }
    if (!this.quietCommands && ['console', 'target', 'log'].includes(record.type) && record.text) {
      this.log(record.text);
      this.emit('output', record.text);
    }
  }

  private async handleStop(event: MiTuple): Promise<void> {
    if (this.stopping) return;
    const check = this.watchResume;
    this.watchResume = undefined;
    // TCG 单步遇到 watch 后可能补交一个未执行任何指令的 SIGTRAP。
    // 只滤掉紧接的一次全寄存器不变的 trap；LOOP/REP 的同 PC 真实进展必须保留。
    if (check && event.reason === 'signal-received' && event['signal-name'] === 'SIGTRAP' && !this.pauseRequested) {
      const current = await this.requireClient().transaction(execute => this.readRegisters(execute));
      if (Object.keys(current).every(name => current[name] === check.registers[name]) && Object.keys(check.registers).every(name => current[name] === check.registers[name])) {
        const resumed = await this.requireClient().transaction(async execute => {
          if (this.stopping || this.pauseRequested) return false;
          this.running = true;
          this.physicalStopped = false;
          try { await execute(check.command); }
          catch (error) { this.running = false; this.physicalStopped = true; throw error; }
          return true;
        });
        if (resumed) return;
      }
    }
    this.running = false;
    this.watchStopped = typeof event.reason === 'string' && /watchpoint-trigger/.test(event.reason);
    this.emit('stopped', event);
  }

  private async quietly(execute: (command: string) => Promise<MiRecord>, command: string): Promise<MiRecord> {
    this.quietCommands++;
    try { return await execute(command); }
    finally { this.quietCommands--; }
  }

  private requireClient(): MiClient {
    if (!this.client || this.stopping) throw new Error('GDB 调试会话尚未启动或已经结束');
    return this.client;
  }
  private requireStopped(): MiClient {
    const client = this.requireClient();
    if (this.running) throw new Error('请先暂停 CPU，再读取寄存器、内存或修改断点');
    return client;
  }
  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.emit('terminated', error ? { error: error.message } : {});
  }
}

function validateRange(address: number, count: number): void {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff || !Number.isSafeInteger(count) || count < 0 || count > 65536 || address + count > 0x100000000) throw new Error('内存地址必须为 32 位整数，长度为 0..65536 且不能溢出');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('无法选择 QEMU 调试端口'));
        else resolve(address.port);
      });
    });
  });
}
