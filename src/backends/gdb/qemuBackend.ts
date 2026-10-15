import { MiClient } from './miClient';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { VirtualMachine } from '../../ports/virtualMachine';
import { Project } from '../../project/model';
import { CapabilityLedger } from '../../dependencies/capabilities';
import { localHost } from '../../platform/host';
import { cpuMode } from '../../domain/x86/state';
import { monitorRegisters } from '../../backends/qemu/monitor';
import { MiRecord, MiTuple, MiValue, miQuote } from './miParser';

import { validateDebugElf } from './elf';
import { gdbPathQuote } from './path';
const tuple = (value: MiValue | undefined): MiTuple | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

/** C 模式只有 GDB 持有 QEMU GDB socket，避免两套 RSP 客户端争用目标。 */
export class QemuGdbBackend extends EventEmitter {
  readonly capabilities: CapabilityLedger;
  private client?: MiClient;
  private clientStartup?: Promise<MiClient>;
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
  private readonly startup = new AbortController();

  constructor(private readonly project: Project, private readonly log: (text: string) => void, private readonly machine: VirtualMachine) {
    super();
    const tools: Record<string, string> = {};
    const selectedTools: [string, string | undefined][] = [['qemu', project.qemu], ['gdb', project.debug?.gdb]];
    for (const [name, requested] of selectedTools) {
      if (typeof requested !== 'string') continue;
      tools[name] = requested;
    }
    this.capabilities = new CapabilityLedger({
      sessionId: randomUUID(), targetId: project.image, backend: 'c-gdb-mi',
      host: localHost.identity, tools, machine: project.qemuArgs,
    });
  }

  isRunning(): boolean { return this.running; }

  async launch(): Promise<void> {
    if (this.launched || this.stopping) throw new Error('C 调试运行时不能重复启动');
    this.launched = true;
    const debug = this.project.debug;
    if (!debug) throw new Error('C 源码调试需要配置 debug.elf 与 gdbPath');
    try {
      await validateDebugElf(debug.elf);
      if (this.stopping) throw new Error('C 调试启动已取消');
      const run = await this.machine.start({ debug: true, paused: true });
      const endpoint = run.debugEndpoint;
      if (!endpoint) throw new Error('虚拟机未提供调试连接端点');
      const qemuExecutable = run.executable;
      this.capabilities.bindTools({ qemu: qemuExecutable, gdb: debug.gdb });
      let qemuError: Error | undefined;
      void run.exited.then(() => {
        qemuError = new Error('QEMU 已退出');
        if (!this.stopping) { this.finish(qemuError); void this.dispose(); }
      }, error => {
        qemuError = error as Error;
        if (!this.stopping) { this.finish(qemuError); void this.dispose(); }
      });
      this.client = await (this.clientStartup = MiClient.start(debug.gdb, ['--nx', '--nh', '--quiet', '--interpreter=mi2', '-iex', 'set auto-load off', '-iex', 'set debuginfod enabled off', '-iex', 'set may-call-functions off'], this.project.root, 15000, this.startup.signal));
      this.capabilities.bindTools({ qemu: qemuExecutable, gdb: this.client.executable ?? debug.gdb });
      if (this.stopping) { await this.client.dispose(); throw new Error('C 调试启动已取消'); }
      const client = this.client;
      client.on('record', (record: MiRecord) => this.record(record));
      client.on('stderr', (text: string) => { this.log(text); this.emit('output', text); });
      client.on('stdout', (text: string) => { this.log(text); this.emit('output', text); });
      client.on('terminated', (error: Error) => { if (!this.stopping) { this.finish(error); void this.dispose(); } });
      for (const setting of ['auto-load off', 'debuginfod enabled off', 'may-call-functions off', 'pagination off', 'confirm off', 'mi-async on', 'language c', 'architecture i386', 'trust-readonly-sections off', 'stack-cache off', 'code-cache off', 'mem inaccessible-by-default off']) await client.command(`-gdb-set ${setting}`);
      await client.command(`-file-exec-and-symbols ${miQuote(debug.elf)}`);
      this.capabilities.record('gdb.mi', {
        state: 'supported', evidence: 'protocol', reason: '当前 GDB MI 通道已完成初始化设置与 ELF 符号加载',
      });
      for (const [before, after] of Object.entries(debug.sourceMap ?? {})) {
        await client.command(`-interpreter-exec console ${miQuote(`set substitute-path ${gdbPathQuote(before)} ${gdbPathQuote(after)}`)}`);
      }
      const deadline = Date.now() + 8000;
      while (true) {
        if (this.stopping || qemuError) throw qemuError ?? new Error('C 调试启动已取消');
        try { await client.command(`-target-select remote ${endpoint.host}:${endpoint.port}`); break; }
        catch (error) {
          if (Date.now() >= deadline) throw new Error(`GDB 无法连接 QEMU：${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
      }
      const names = (await client.command('-data-list-register-names')).results['register-names'];
      try {
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('GDB 返回无效的寄存器名称');
        this.registerNames = names as string[];
        for (const name of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
          if (!this.registerNames.includes(name)) throw new Error(`当前 C 调试仅支持 i386 32 位寄存器布局，缺少 ${name}`);
        }
      } catch (error) {
        this.capabilities.record('qemu.rspTarget', { state: 'unsupported', evidence: 'protocol', reason: (error as Error).message });
        throw error;
      }
      this.capabilities.record('qemu.rspTarget', {
        state: 'supported', evidence: 'protocol',
        reason: '当前 GDB MI 通道已连接 QEMU 并确认必需 i386 寄存器；未另建 RSP 通道或读取 target XML',
      });
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
      try {
        Object.assign(registers, monitorRegisters(monitor.console ?? ''));
        const mode = cpuMode(registers);
        this.capabilities.record('qemu.segmentRegisters', {
          state: 'supported', evidence: 'protocol', reason: '当前 GDB MI monitor 的 CR0 与段缓存已解析并通过 CPU 模式校验',
          details: { mode },
        });
      } catch (error) {
        this.capabilities.record('qemu.segmentRegisters', {
          state: 'unsupported', evidence: 'protocol', reason: (error as Error).message,
        });
        throw error;
      }
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
      if (mode !== '0' && mode !== '1') {
        const error = new Error('当前 QEMU 不支持物理内存读取（qqemu.PhyMemMode）');
        this.capabilities.record('qemu.physicalMemory', { state: 'unsupported', evidence: 'protocol', reason: error.message });
        throw error;
      }
      let result: Buffer;
      try {
        try { if (await packet('Qqemu.PhyMemMode:1') !== 'OK') throw new Error('无法启用 QEMU 物理内存模式'); }
        catch (error) {
          this.capabilities.record('qemu.physicalMemory', { state: 'unsupported', evidence: 'protocol', reason: (error as Error).message });
          throw error;
        }
        const buffers: Buffer[] = [];
        for (let offset = 0; offset < count; offset += 512) {
          const size = Math.min(512, count - offset);
          const response = await packet(`m${(address + offset).toString(16)},${size.toString(16)}`);
          if (!/^(?:[\da-f]{2})+$/i.test(response) || response.length !== size * 2) throw new Error('QEMU 返回不完整的物理内存数据');
          buffers.push(Buffer.from(response, 'hex'));
        }
        result = Buffer.concat(buffers);
      } finally {
        try { if (await packet('Qqemu.PhyMemMode:0') !== 'OK') throw new Error('QEMU 拒绝恢复虚拟地址模式'); }
        catch (error) {
          const failure = new Error(`物理内存读取后无法恢复虚拟地址模式，会话已关闭：${(error as Error).message}`);
          this.capabilities.record('qemu.physicalMemory', { state: 'unsupported', evidence: 'protocol', reason: failure.message });
          this.finish(failure);
          void this.dispose();
          throw failure;
        }
      }
      this.capabilities.record('qemu.physicalMemory', {
        state: 'supported', evidence: 'protocol', reason: '当前 GDB MI 维护包通道已完成非零物理内存读取并恢复虚拟地址模式',
        details: { bytesRead: result.length },
      });
      return result;
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
    this.startup.abort();
    this.disposal = Promise.allSettled([
      this.client?.dispose(), this.machine.dispose(),
      this.clientStartup?.then(client => client.dispose(), () => undefined),
    ]).then(() => { this.finish(); });
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
