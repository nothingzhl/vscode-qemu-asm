import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { monitorRegisters } from '../../backends/qemu/monitor';
import { decodeRegisters, RegisterLayout, registerLayout, RspClient } from '../../debug/rsp';
import { CapabilityLedger } from '../../dependencies/capabilities';
import { cpuMode, instructionAddress } from '../../domain/x86/state';
import { localHost } from '../../platform/host';
import type { VirtualMachine } from '../../ports/virtualMachine';
import { Project } from '../../project/model';
import { RspBreakpoints } from './rspBreakpoints';
import { RspMemory } from './rspMemory';
import { stoppedEvent } from './rspStopped';
import { readTarget } from './rspTarget';
import { expectOK } from './rspValidation';
export { stoppedEvent } from './rspStopped';

import { AssemblyBackend, DataWatchpoint, StoppedEvent } from '../../ports/machine';
/** 只负责一个单 CPU 的 QEMU 进程；源码映射由 DAP 适配器负责。 */
export class QemuRspBackend extends EventEmitter implements AssemblyBackend {
  readonly capabilities: CapabilityLedger;
  private client?: RspClient;
  private layout: RegisterLayout[] = [];
  private readonly bindings = new RspBreakpoints(
    () => this.requireStopped(),
    async (error) => {
      this.finish(error);
      await this.dispose();
    }
  );
  private readonly memory: RspMemory;
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

  constructor(
    project: Project,
    private readonly machine: VirtualMachine
  ) {
    super();
    const tools: Record<string, string> = {};
    for (const [name, requested] of [
      ['nasm', project.nasm],
      ['qemu', project.qemu]
    ]) {
      if (typeof requested !== 'string') continue;
      tools[name] = requested;
    }
    this.capabilities = new CapabilityLedger({
      sessionId: randomUUID(),
      targetId: project.image,
      backend: 'nasm-rsp',
      host: localHost.identity,
      tools,
      machine: project.qemuArgs
    });
    this.memory = new RspMemory(() => this.requireStopped(), this.capabilities);
  }

  async launch(): Promise<void> {
    if (this.launched || this.stopping) throw new Error('调试运行时不能重复启动');
    this.launched = true;
    try {
      const run = await this.machine.start({ debug: true, paused: true });
      const endpoint = run.debugEndpoint;
      if (!endpoint) throw new Error('虚拟机未提供调试连接端点');
      this.capabilities.bindTools({ qemu: run.executable });
      let processError: Error | undefined;
      void run.exited.then(
        () => {
          processError = new Error('QEMU 已退出');
          if (!this.stopping) {
            this.finish(processError);
            void this.dispose();
          }
        },
        (error) => {
          processError = error as Error;
          if (!this.stopping) {
            this.finish(processError);
            void this.dispose();
          }
        }
      );
      const deadline = Date.now() + 8000;
      while (!this.client) {
        if (this.stopping || processError) throw processError ?? new Error('调试启动已取消');
        try {
          this.client = await RspClient.connect(endpoint.port, endpoint.host, 400);
        } catch (error) {
          if (Date.now() >= deadline) throw new Error(`无法连接 QEMU 调试接口：${(error as Error).message}`);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
      if (this.stopping) {
        this.client.close();
        throw new Error('调试启动已取消');
      }
      this.client.on('disconnect', (error: Error) => {
        if (!this.stopping) {
          this.finish(error);
          void this.dispose();
        }
      });
      this.client.on('exit', () => {
        this.finish();
        void this.dispose();
      });
      this.client.on('stop', (packet: string) => {
        this.physicalStop = true;
        this.stopPackets = this.stopPackets
          .then(() => this.handleStop(packet))
          .catch((error) => {
            this.finish(error as Error);
            void this.dispose();
          });
      });
      await this.client.command('qSupported:multiprocess+;qXfer:features:read+;xmlRegisters=i386');
      const target = await readTarget(this.client, 'target.xml');
      try {
        if (!/<architecture>\s*i386\s*<\/architecture>/.test(target))
          throw new Error('当前调试仅支持 QEMU i386 32 位寄存器布局，不支持 64 位 CPU');
        this.layout = registerLayout(target);
        const names = new Set(this.layout.map((register) => register.name));
        for (const name of [
          'eax',
          'ecx',
          'edx',
          'ebx',
          'esp',
          'ebp',
          'esi',
          'edi',
          'eip',
          'eflags',
          'cs',
          'ss',
          'ds',
          'es',
          'fs',
          'gs'
        ]) {
          if (!names.has(name)) throw new Error(`QEMU 寄存器描述缺少 ${name}`);
        }
      } catch (error) {
        this.capabilities.record('qemu.rspTarget', {
          state: 'unsupported',
          evidence: 'protocol',
          reason: (error as Error).message
        });
        throw error;
      }
      this.capabilities.record('qemu.rspTarget', {
        state: 'supported',
        evidence: 'protocol',
        reason: '当前 QEMU RSP 通道的 target XML 已确认 i386 架构与必需寄存器布局'
      });
      const stopped = await this.client.command('?');
      if (!/^[TS][0-9a-f]{2}/i.test(stopped)) throw new Error('QEMU 没有在启动时暂停');
      await this.registers();
      this.emit('stopped', { reason: 'entry' } satisfies StoppedEvent);
    } catch (error) {
      this.finish(error as Error);
      await this.dispose();
      throw error;
    }
  }

  setBreakpoints(addresses: number[]): Promise<void> {
    return this.bindings.setBreakpoints(addresses);
  }

  /** 整批替换数据断点。失败时恢复旧集合，不把半完成的设置留给适配器。 */
  setDataBreakpoints(points: DataWatchpoint[]): Promise<void> {
    return this.bindings.setDataBreakpoints(points);
  }

  async resume(step = false): Promise<void> {
    const client = this.requireStopped();
    const registers = await this.registers();
    const address = instructionAddress(registers);
    this.watchTrapCheck = this.steppedWatch ? { registers, step } : undefined;
    this.steppedWatch = false;
    this.pauseRequested = false;
    this.nextStop = step ? 'step' : 'breakpoint';
    if (this.bindings.breakpoints.has(address)) {
      // QEMU 的 Z1 在 c 后会原地再次触发，先临时移除并完成一条指令。
      expectOK(await client.command(`z1,${address.toString(16)},1`), '临时移除硬件断点');
      this.breakpointStep = { address, step, pause: false, awaiting: true };
    }
    this.running = true;
    this.physicalStop = false;
    try {
      await client.resume(this.breakpointStep ? true : step);
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async pause(): Promise<void> {
    const client = this.requireClient();
    if (!this.running) return;
    this.pauseRequested = true;
    if (this.breakpointStep) this.breakpointStep.pause = true;
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
        reject(new Error('暂停前 QEMU 已退出'));
      };
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
        if (!this.physicalStop && (!this.breakpointStep || this.breakpointStep.awaiting)) {
          void Promise.resolve(client.interrupt()).catch((error) => {
            cleanup();
            reject(error);
          });
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async registers(): Promise<Record<string, number>> {
    return this.readRegisters(this.requireStopped());
  }

  private async readRegisters(client: RspClient): Promise<Record<string, number>> {
    const registers = decodeRegisters(await client.command('g'), this.layout);
    const monitor = await client.command(`qRcmd,${Buffer.from('info registers').toString('hex')}`);
    try {
      Object.assign(registers, monitorRegisters(monitor));
      const mode = cpuMode(registers);
      this.capabilities.record('qemu.segmentRegisters', {
        state: 'supported',
        evidence: 'protocol',
        reason: '当前 RSP monitor 的 CR0 与段缓存已解析并通过 CPU 模式校验',
        details: { mode }
      });
    } catch (error) {
      this.capabilities.record('qemu.segmentRegisters', {
        state: 'unsupported',
        evidence: 'protocol',
        reason: (error as Error).message
      });
      throw error;
    }
    return registers;
  }

  readMemory(address: number, count: number): Promise<Buffer> {
    return this.memory.readMemory(address, count);
  }

  /** QEMU 的 m 包默认读取线性地址；页表必须在独占事务中显式切换成物理地址。 */
  readPhysicalMemory(address: number, count: number): Promise<Buffer> {
    return this.memory.readPhysicalMemory(address, count);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopping = true;
    this.running = false;
    this.client?.close();
    this.disposal = this.machine.dispose().then(() => this.finish());
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
    if (
      check &&
      event.signal === 5 &&
      event.reason !== 'data breakpoint' &&
      !this.pauseRequested &&
      !this.breakpointStep?.pause
    ) {
      const current = await this.readRegisters(this.requireClient());
      if (
        Object.keys(check.registers).every((name) => current[name] === check.registers[name]) &&
        Object.keys(current).every((name) => current[name] === check.registers[name]) &&
        !this.pauseRequested &&
        !this.breakpointStep?.pause
      ) {
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
    if (event.reason !== 'data breakpoint' && event.signal === 5 && this.pauseRequested)
      event.reason = 'pause';
    this.pauseRequested = false;
    if (event.reason === 'data breakpoint' && this.nextStop === 'step') this.steppedWatch = true;
    this.emit('stopped', event);
  }

  private async afterBreakpointStep(
    packet: string,
    internal: { address: number; step: boolean; pause: boolean }
  ): Promise<void> {
    if (this.stopping) return;
    const client = this.requireClient();
    expectOK(await client.command(`Z1,${internal.address.toString(16)},1`), '恢复硬件断点');
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
}
