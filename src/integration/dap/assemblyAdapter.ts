import { releaseAll } from '../../application/release';
import * as path from 'node:path';
import type { DebugAdapter, DebugProtocolMessage } from 'vscode';
import { AssemblyFrames } from '../../application/assembly/frames';
import { AssemblySources } from '../../application/assembly/sources';
import { nextCallTarget } from '../../application/assembly/stepping';
import { AssemblyVariables } from '../../application/assembly/variables';
import { MachineBreakpoints } from '../../application/machine/breakpoints';
import { SessionResourceOwner } from '../../application/sessionResources';
import { cpuMode, instructionAddress } from '../../domain/x86/state';
import type { StoppedEvent } from '../../ports/machine';
import { AssemblyBreakpointRequests } from './assemblyBreakpoints';
import { AssemblyViewRequests } from './assemblyViews';
import { DapChannel } from './channel';
import { InspectionRequests } from './inspectionRequests';
import { MachineRequests } from './machineRequests';

import type { AssemblyBackend } from '../../ports/machine';
import type { AssemblySessionOptions } from '../../ports/session';
interface Request {
  seq: number;
  command: string;
  arguments?: Record<string, unknown>;
}
const hex = (value: number, digits = 4) =>
  `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
const integer = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
/** VS Code 内联 DAP 适配器；同样可在 Node 集成测试中驱动，不模拟调试协议。 */
export class AssemblyDapAdapter implements DebugAdapter {
  private readonly channel = new DapChannel(
    (request) => this.dispatch(request),
    () => this.finish(),
    ['qemuAsm.inspectMemory', 'qemuAsm.inspectDescriptors', 'qemuAsm.inspectPaging', 'qemuAsm.disassemble']
  );
  readonly onDidSendMessage = this.channel.onDidSendMessage;
  handleMessage(message: DebugProtocolMessage): void {
    this.channel.handleMessage(message);
  }
  private epoch = 0;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private userAddresses: number[] = [];
  private readonly machine = new MachineBreakpoints();
  private lastDataHit?: {
    address: number;
    access: 'read' | 'write' | 'readWrite';
    ids: number[];
    pc: number;
  };
  private bootPending = false;
  private temporary?: number;
  private stopOnEntry = true;
  private internalPause = false;
  private internalStop?: StoppedEvent;
  private ended = false;
  private disposed = false;
  private finishing?: Promise<void>;
  private launchArgs: Record<string, unknown> = {};
  private readonly sources = new AssemblySources(
    () => this.requireStopped(),
    (reader) => this.resources.backend === reader && this.phase === 'stopped'
  );
  private readonly framesView = new AssemblyFrames(
    () => this.requireStopped(),
    (at, bits, registers) => this.sources.locateLive(at, bits, registers)
  );
  private readonly variablesView = new AssemblyVariables(() => this.requireStopped());
  private readonly views = new AssemblyViewRequests(
    this.framesView,
    this.variablesView,
    () => {
      this.trust();
      return this.phase === 'stopped';
    },
    () => this.requireStopped(),
    (request, body) => this.response(request, body)
  );
  private readonly machineRequests = new MachineRequests(
    this.machine,
    { configure: () => this.breakpointRuntime(), stopped: () => this.requireStopped() },
    {
      instructions: (addresses) =>
        this.breakpointRuntime().setBreakpoints(this.executionAddresses(addresses)),
      watches: (points) => this.breakpointRuntime().setDataBreakpoints(points)
    },
    () => this.lastDataHit,
    (request, body) => this.response(request, body)
  );
  private readonly sourceRequests = new AssemblyBreakpointRequests(
    this.sources,
    (report) => this.updateSourceBreakpoints(report),
    () => this.trust(),
    (request, body) => this.response(request, body)
  );
  private readonly resources: SessionResourceOwner<AssemblyBackend>;
  private readonly inspections: InspectionRequests;
  constructor(private readonly options: AssemblySessionOptions) {
    this.resources = new SessionResourceOwner(options.createResources);
    this.inspections = new InspectionRequests(
      () => this.requireStopped(),
      options.decoder,
      () => this.machine.instructions().breakpoints,
      (request, body) => this.response(request, body)
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.channel.close();
    await releaseAll([() => this.finish(), () => this.options.builder.dispose()]);
  }

  private event(event: string, body: Record<string, unknown> = {}): void {
    this.channel.send({ type: 'event', event, body });
  }
  private response(request: Request, body: unknown = {}): void {
    this.channel.send({
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body
    });
  }
  private output(text: string, category = 'console'): void {
    this.options.log?.(text);
    this.event('output', { category, output: text });
  }
  private trust(): void {
    if (!this.options.isTrusted()) throw new Error('请先信任工作区，才能启动或控制调试器');
  }
  private requireStopped(): AssemblyBackend {
    this.trust();
    if (!this.resources.backend || this.phase !== 'stopped')
      throw new Error('请先暂停程序，再查看寄存器或栈内存');
    return this.resources.backend;
  }

  private async prepare(args: Record<string, unknown>): Promise<void> {
    this.trust();
    if (this.disposed) throw new Error('调试适配器已释放');
    this.launchArgs = args;
    this.stopOnEntry = args.stopOnEntry !== false;
    this.ended = false;
    this.lastDataHit = undefined;
    this.phase = 'preparing';
    const epoch = ++this.epoch;
    const project = await this.options.getProject();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.trust();
    const maps = await this.options.sources.load(
      project,
      (text) => this.output(text, 'stderr'),
      () => epoch !== this.epoch
    );
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    await this.sources.set(maps);
    this.trust();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.userAddresses = this.sources.addresses();
    const { backend: runtime } = await this.resources.allocate(
      project,
      (text) => this.output(text, 'stdout'),
      () => {
        this.trust();
        if (epoch !== this.epoch) throw new Error('调试启动已取消');
      }
    );
    runtime.on('stopped', (event: StoppedEvent) => {
      if (epoch !== this.epoch || this.phase === 'preparing') return;
      if (this.internalPause) {
        this.internalStop = event;
        return;
      }
      // Record the physical stop before queued breakpoint requests can decide to resume.
      this.phase = 'stopped';
      this.channel.queue = this.channel.queue
        .then(async () => {
          if (epoch === this.epoch) await this.onStopped(event);
        })
        .catch((error) => this.channel.fail(error));
    });
    runtime.on('terminated', (result: { error?: string }) => {
      if (epoch !== this.epoch) return;
      if (result.error) this.output(`${result.error}\n`, 'stderr');
      void this.finish().catch((error) => this.output(`调试资源清理失败：${String(error)}\n`, 'stderr'));
    });
    await runtime.launch();
    if (this.machine.dataPoints().length) await runtime.setDataBreakpoints(this.machine.dataPoints());
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    await this.resources.connect();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.phase = 'configuring';
    this.output(
      '16/32 位引导调试已就绪。支持实模式、非 PAE 保护模式分页，以及寄存器、栈内存和 BP/EBP 栈帧链。\n'
    );
  }

  /** NASM listings describe their original load addresses. A remapped virtual
   * address must not acquire unrelated source lines or instruction sizes. */

  private async installBreakpoints(): Promise<void> {
    await this.resources.backend?.setBreakpoints([
      ...new Set([
        ...this.userAddresses,
        ...this.machine.instructionAddresses(),
        ...(this.temporary === undefined ? [] : [this.temporary])
      ])
    ]);
  }
  private async boot(): Promise<void> {
    if (!this.sources.map || !this.resources.backend) throw new Error('调试器未启动');
    this.phase = 'booting';
    this.bootPending = true;
    this.temporary = this.sources.map.origin;
    await this.installBreakpoints();
    await this.resources.backend.resume();
  }
  private async onStopped(event: StoppedEvent): Promise<void> {
    if (this.internalPause || !this.resources.backend || this.phase === 'ended') return;
    const temporary = this.temporary;
    this.phase = 'stopped';
    const registers = await this.resources.backend.registers();
    const mode = cpuMode(registers),
      bits = mode === 'protected32' ? 32 : 16;
    const pc = instructionAddress(registers);
    const entry = this.bootPending && pc === this.sources.map?.origin;
    if (entry) this.bootPending = false;
    if (temporary !== undefined && !this.bootPending) {
      this.temporary = undefined;
      await this.installBreakpoints();
    }
    const dataStop = event.reason === 'data breakpoint';
    if (
      entry &&
      !dataStop &&
      !this.stopOnEntry &&
      !this.userAddresses.includes(pc) &&
      !this.machine.instructionHit(pc).length
    ) {
      await this.continue(false);
      return;
    }
    const reason = dataStop ? 'data breakpoint' : entry ? 'entry' : temporary === pc ? 'step' : event.reason;
    const hitIds =
      dataStop && event.dataAddress !== undefined
        ? this.machine.dataHits(event.dataAddress, event.dataAccess ?? 'readWrite')
        : event.reason === 'breakpoint'
          ? this.machine.instructionHit(pc)
          : [];
    if (dataStop && event.dataAddress !== undefined)
      this.lastDataHit = {
        address: event.dataAddress,
        access: event.dataAccess ?? 'readWrite',
        ids: hitIds,
        pc
      };
    const source = await this.sources.locateLive(pc, bits, registers);
    const location = `${mode} ${hex(registers.cs)}:${hex(mode === 'real16' ? registers.eip & 0xffff : registers.eip, mode === 'real16' ? 4 : 8)} → ${hex(pc)}`;
    this.output(
      `[暂停 ${reason}] ${location}${source ? ` ${path.basename(source.map.sourcePath)} 第 ${source.entry.line} 行：${source.entry.text.trim()}` : '（当前地址无匹配代码模式的源码）'}\n`
    );
    this.event('stopped', {
      reason,
      threadId: 1,
      allThreadsStopped: true,
      description:
        dataStop && event.dataAddress !== undefined
          ? `数据断点 ${hex(event.dataAddress)}（${event.dataAccess ?? 'readWrite'}）；访问已完成，${location}`
          : location,
      ...(hitIds.length ? { hitBreakpointIds: hitIds } : {})
    });
    this.event('invalidated', { areas: ['stacks', 'variables'] });
  }
  private async continue(step: boolean): Promise<void> {
    const runtime = this.requireStopped();
    await runtime.resume(step);
    this.phase = 'running';
    this.event('continued', { threadId: 1, allThreadsContinued: true });
  }

  private async updateSourceBreakpoints(report: () => void): Promise<void> {
    this.userAddresses = this.sources.addresses();
    const previousPhase = this.phase;
    const wasRunning = previousPhase === 'running' || previousPhase === 'booting';
    if (wasRunning && this.resources.backend) {
      this.internalStop = undefined;
      this.internalPause = true;
      try {
        await this.resources.backend.pause();
      } finally {
        this.internalPause = false;
      }
      this.phase = 'stopped';
    }
    if (this.resources.backend && this.phase !== 'preparing') await this.installBreakpoints();

    report();
    if (wasRunning) {
      const natural = this.internalStop as StoppedEvent | undefined;
      this.internalStop = undefined;
      if (natural && natural.reason !== 'pause') await this.onStopped(natural);
      else {
        await this.continue(false);
        if (previousPhase === 'booting') this.phase = 'booting';
      }
    }
  }

  private async dispatch(request: Request): Promise<void> {
    if (await this.sourceRequests.handle(request)) return;
    if (await this.views.handle(request)) return;
    if (await this.inspections.handle(request)) return;
    if (await this.machineRequests.handle(request)) return;
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'initialize':
        this.response(request, {
          supportsConfigurationDoneRequest: true,
          supportsReadMemoryRequest: true,
          supportsEvaluateForHovers: true,
          supportsTerminateRequest: true,
          supportsRestartRequest: true,
          supportsStepBack: false,
          supportsSetVariable: false,
          supportsDisassembleRequest: true,
          supportsInstructionBreakpoints: true,
          supportsDataBreakpoints: true
        });
        return;
      case 'launch':
        await this.prepare(args);
        this.response(request);
        this.event('initialized');
        return;
      case 'configurationDone':
        await this.boot();
        this.response(request);
        return;
      case 'qemuAsm.dependencyReport':
        this.trust();
        if (!this.resources.backend) throw new Error('调试运行时尚未启动');
        this.response(request, this.resources.backend.capabilities.snapshot());
        return;
      case 'threads':
        this.response(request, { threads: [{ id: 1, name: 'CPU 0（x86 16/32 位）' }] });
        return;

      case 'continue':
        await this.continue(false);
        this.response(request, { allThreadsContinued: true });
        return;
      case 'stepIn':
        await this.continue(true);
        this.response(request);
        return;
      case 'next': {
        const target = await nextCallTarget(
          this.requireStopped(),
          (at, bits, registers) => this.sources.locateLive(at, bits, registers),
          this.options.decoder
        );
        if (target !== undefined) {
          this.temporary = target;
          await this.installBreakpoints();
          await this.continue(false);
        } else await this.continue(true);
        this.response(request);
        return;
      }
      case 'stepOut': {
        const frames = await this.framesView.frames();
        if (frames.length < 2) throw new Error('没有可验证的 BP 调用者栈帧，无法执行跳出');
        this.temporary = Number(frames[1].instructionPointerReference);
        await this.installBreakpoints();
        await this.continue(false);
        this.response(request);
        return;
      }
      case 'pause':
        this.trust();
        await this.resources.backend?.pause();
        this.response(request);
        return;

      case 'readMemory': {
        const address = this.address(String(args.memoryReference ?? '')) + integer(args.offset, 0);
        const count = integer(args.count, 0);
        if (count < 0 || count > 4096) throw new Error('每次最多读取 4096 字节');
        const data = await this.requireStopped().readMemory(address, count);
        this.response(request, { address: hex(address), data: data.toString('base64') });
        return;
      }

      case 'restart':
        if (this.ended) {
          await this.finish();
          throw new Error('调试会话已结束，请重新启动调试');
        }
        await this.cleanup();
        await this.prepare(this.launchArgs);
        await this.boot();
        this.response(request);
        return;
      case 'disconnect':
      case 'terminate':
        this.response(request);
        await this.finish();
        return;
      case 'setExceptionBreakpoints':
        this.response(request, { breakpoints: [] });
        return;
      default:
        throw new Error(`当前调试器不支持请求：${request.command}`);
    }
  }
  private executionAddresses(instructions = this.machine.instructionAddresses()): number[] {
    return [
      ...new Set([
        ...this.userAddresses,
        ...instructions,
        ...(this.temporary === undefined ? [] : [this.temporary])
      ])
    ];
  }
  private breakpointRuntime(): AssemblyBackend {
    this.trust();
    if (!this.resources.backend || !['stopped', 'configuring'].includes(this.phase))
      throw new Error('请先暂停程序，再修改断点');
    return this.resources.backend;
  }

  private address(text: string): number {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error('内存地址必须为十进制或 0x 十六进制');
    return Number(text);
  }
  private async cleanup(): Promise<void> {
    ++this.epoch;
    await releaseAll([() => this.resources.release(), () => this.options.builder.stop()]);
    this.temporary = undefined;
    this.bootPending = false;
    this.lastDataHit = undefined;
  }
  private finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.ended = true;
    this.phase = 'ended';
    this.finishing = this.cleanup().finally(() => {
      this.event('terminated');
    });
    return this.finishing;
  }
}
