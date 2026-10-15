import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CapabilityLedger } from '../../dependencies/capabilities';
import { localHost } from '../../platform/host';
import type { VirtualMachine } from '../../ports/virtualMachine';
import { Project } from '../../project/model';
import { configureGdb } from './configure';
import { GdbMemory } from './memory';
import { MiClient } from './miClient';
import { MiRecord, MiTuple, miQuote } from './miParser';
import { readGdbRegisters } from './registers';

import { validateDebugElf } from './elf';
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
  private readonly memory: GdbMemory;
  private registerNames: string[] = [];
  private initialStop: MiTuple = {};
  private disposal?: Promise<void>;
  private readonly startup = new AbortController();

  constructor(
    private readonly project: Project,
    private readonly log: (text: string) => void,
    private readonly machine: VirtualMachine
  ) {
    super();
    const tools: Record<string, string> = {};
    const selectedTools: [string, string | undefined][] = [
      ['qemu', project.qemu],
      ['gdb', project.debug?.gdb]
    ];
    for (const [name, requested] of selectedTools) {
      if (typeof requested !== 'string') continue;
      tools[name] = requested;
    }
    this.capabilities = new CapabilityLedger({
      sessionId: randomUUID(),
      targetId: project.image,
      backend: 'c-gdb-mi',
      host: localHost.identity,
      tools,
      machine: project.qemuArgs
    });
    this.memory = new GdbMemory(
      () => this.requireStopped(),
      (execute, command) => this.quietly(execute, command),
      this.capabilities,
      (error) => {
        this.finish(error);
        void this.dispose();
      }
    );
  }

  isRunning(): boolean {
    return this.running;
  }

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
      void run.exited.then(
        () => {
          qemuError = new Error('QEMU 已退出');
          if (!this.stopping) {
            this.finish(qemuError);
            void this.dispose();
          }
        },
        (error) => {
          qemuError = error as Error;
          if (!this.stopping) {
            this.finish(qemuError);
            void this.dispose();
          }
        }
      );
      this.client = await (this.clientStartup = MiClient.start(
        debug.gdb,
        [
          '--nx',
          '--nh',
          '--quiet',
          '--interpreter=mi2',
          '-iex',
          'set auto-load off',
          '-iex',
          'set debuginfod enabled off',
          '-iex',
          'set may-call-functions off'
        ],
        this.project.root,
        15000,
        this.startup.signal
      ));
      this.capabilities.bindTools({ qemu: qemuExecutable, gdb: this.client.executable ?? debug.gdb });
      if (this.stopping) {
        await this.client.dispose();
        throw new Error('C 调试启动已取消');
      }
      const client = this.client;
      client.on('record', (record: MiRecord) => this.record(record));
      client.on('stderr', (text: string) => {
        this.log(text);
        this.emit('output', text);
      });
      client.on('stdout', (text: string) => {
        this.log(text);
        this.emit('output', text);
      });
      client.on('terminated', (error: Error) => {
        if (!this.stopping) {
          this.finish(error);
          void this.dispose();
        }
      });
      this.registerNames = await configureGdb(client, debug, endpoint, this.capabilities, () => {
        if (this.stopping || qemuError) throw qemuError ?? new Error('C 调试启动已取消');
      });
      this.running = false;
      await this.registers();
      this.active = true;
      this.emit('stopped', { ...this.initialStop, reason: 'entry' });
    } catch (error) {
      this.finish(error as Error);
      await this.dispose();
      throw error;
    }
  }

  mi(command: string): Promise<MiRecord> {
    const client = this.requireClient();
    return client.transaction(async (execute) => {
      this.requireClient();
      const starts = /^-exec-(?:continue|step|next|finish|until|jump|run)(?:-instruction)?(?:\s|$)/.test(
        command
      );
      if (starts) {
        if (this.running) throw new Error('CPU 正在运行');
        this.watchResume = this.watchStopped
          ? { registers: await this.readRegisters(execute), command }
          : undefined;
        this.watchStopped = false;
        this.pauseRequested = false;
        this.running = true;
        this.physicalStopped = false;
      }
      try {
        return await execute(command);
      } catch (error) {
        if (starts) {
          this.running = false;
          this.physicalStopped = true;
        }
        throw error;
      }
    });
  }

  async console(command: string): Promise<string> {
    this.requireStopped();
    return (await this.mi(`-interpreter-exec console ${miQuote(command)}`)).console ?? '';
  }

  async registers(): Promise<Record<string, number>> {
    return this.requireStopped().transaction(async (execute) => {
      this.requireStopped();
      return this.readRegisters(execute);
    });
  }

  private readRegisters(execute: (command: string) => Promise<MiRecord>): Promise<Record<string, number>> {
    return readGdbRegisters(execute, this.registerNames, this.capabilities, (command, value) =>
      this.quietly(command, value)
    );
  }

  readMemory(address: number, count: number): Promise<Buffer> {
    return this.memory.readMemory(address, count);
  }

  readPhysicalMemory(address: number, count: number): Promise<Buffer> {
    return this.memory.readPhysicalMemory(address, count);
  }

  async resume(step = false): Promise<void> {
    await this.mi(step ? '-exec-step-instruction' : '-exec-continue');
  }

  async pause(): Promise<void> {
    const client = this.requireClient();
    this.pauseRequested = true;
    if (!this.running) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('stopped', stopped);
        this.off('terminated', terminated);
      };
      const stopped = () => {
        cleanup();
        resolve();
      };
      const terminated = () => {
        cleanup();
        reject(new Error('等待暂停时 C 调试会话已结束'));
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error('等待 GDB 暂停超时，会话已关闭');
        this.finish(error);
        void this.dispose();
        reject(error);
      }, 5000);
      this.once('stopped', stopped);
      this.once('terminated', terminated);
      if (!this.physicalStopped)
        void client.command('-exec-interrupt').catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopping = true;
    this.running = false;
    this.startup.abort();
    this.disposal = Promise.allSettled([
      this.client?.dispose(),
      this.machine.dispose(),
      this.clientStartup?.then(
        (client) => client.dispose(),
        () => undefined
      )
    ]).then(() => {
      this.finish();
    });
    return this.disposal;
  }

  private record(record: MiRecord): void {
    if (record.type === 'exec' && record.class === 'running') {
      this.running = true;
      this.physicalStopped = false;
    }
    if (record.type === 'exec' && record.class === 'stopped') {
      this.physicalStopped = true;
      if (typeof record.results.reason === 'string' && /^exited/.test(record.results.reason)) {
        this.finish();
        void this.dispose();
        return;
      }
      if (this.active)
        this.stops = this.stops
          .then(() => this.handleStop(record.results))
          .catch((error) => {
            this.finish(error as Error);
            void this.dispose();
          });
      else {
        this.running = false;
        this.initialStop = record.results;
      }
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
    if (
      check &&
      event.reason === 'signal-received' &&
      event['signal-name'] === 'SIGTRAP' &&
      !this.pauseRequested
    ) {
      const current = await this.requireClient().transaction((execute) => this.readRegisters(execute));
      if (
        Object.keys(current).every((name) => current[name] === check.registers[name]) &&
        Object.keys(check.registers).every((name) => current[name] === check.registers[name])
      ) {
        const resumed = await this.requireClient().transaction(async (execute) => {
          if (this.stopping || this.pauseRequested) return false;
          this.running = true;
          this.physicalStopped = false;
          try {
            await execute(check.command);
          } catch (error) {
            this.running = false;
            this.physicalStopped = true;
            throw error;
          }
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
    try {
      return await execute(command);
    } finally {
      this.quietCommands--;
    }
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
