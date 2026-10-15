import { releaseAll } from '../../application/release';
import * as fs from 'node:fs/promises';
import type { DebugAdapter, DebugProtocolMessage } from 'vscode';
import { hex, integer } from '../../application/format';
import { MachineBreakpoints, machineAddress } from '../../application/machine/breakpoints';
import { SessionResourceOwner } from '../../application/sessionResources';
import { SourceBindings } from '../../application/source/bindings';
import { SourceValues } from '../../application/source/values';
import { instructionAddress } from '../../domain/x86/state';
import type { WatchAccess } from '../../ports/machine';
import type { SessionOptions } from '../../ports/session';
import type { SourceBackend, SourceMotion, SourceStoppedEvent } from '../../ports/source';
import { Project } from '../../project/model';
import { DapChannel } from './channel';
import { InspectionRequests } from './inspectionRequests';
import { MachineRequests } from './machineRequests';
import { SourceBreakpointRequests } from './sourceBreakpoints';
import { SourceViewRequests } from './sourceViews';

interface Request {
  seq: number;
  command: string;
  arguments?: Record<string, unknown>;
}
const watchWarning = 'C / GDB 的写入断点在值改变后暂停；同值写入由 GDB 继续执行。读取与读写断点按访问暂停。';

/** DWARF/source DAP implementation consuming typed source-debugging capabilities. */
export class SourceDapAdapter implements DebugAdapter {
  private readonly channel = new DapChannel(
    (request) => this.dispatch(request),
    () => this.finish(),
    [
      'stackTrace',
      'scopes',
      'variables',
      'evaluate',
      'qemuAsm.inspectMemory',
      'qemuAsm.inspectDescriptors',
      'qemuAsm.inspectPaging',
      'qemuAsm.disassemble'
    ]
  );
  readonly onDidSendMessage = this.channel.onDidSendMessage;
  handleMessage(message: DebugProtocolMessage): void {
    this.channel.handleMessage(message);
  }
  private project?: Project;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private epoch = 0;
  private disposed = false;
  private ended = false;
  private finishing?: Promise<void>;
  private launchArgs: Record<string, unknown> = {};
  private readonly machine = new MachineBreakpoints();
  private stopOnEntry = true;
  private internalPause = false;
  private internalStop?: SourceStoppedEvent;
  private lastDataHit?: { address: number; access: WatchAccess; ids: number[]; pc: number };
  private readonly values = new SourceValues(
    () => this.requireStopped(),
    () => this.resources.backend
  );
  private readonly bindings = new SourceBindings(
    () => this.breakpointRuntime().breakpoints,
    (commands) => this.resources.backend?.breakpoints === commands,
    () => this.finish()
  );
  private readonly views = new SourceViewRequests(
    this.values,
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
      instructions: (addresses) => this.bindings.replaceInstructions(addresses),
      watches: (points) => this.bindings.replaceWatches(points)
    },
    () => this.lastDataHit,
    (request, body) => this.response(request, body),
    watchWarning
  );
  private readonly sourceRequests = new SourceBreakpointRequests(
    this.bindings,
    (change, report) => this.updateSourceBreakpoints(change, report),
    () => this.trust(),
    (request, body) => this.response(request, body)
  );
  private readonly resources: SessionResourceOwner<SourceBackend>;
  private readonly inspections: InspectionRequests;
  constructor(private readonly options: SessionOptions<SourceBackend>) {
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
    this.event('output', { output: text, category });
  }
  private trust(): void {
    if (!this.options.isTrusted()) throw new Error('请先信任工作区，才能启动或控制调试器');
  }
  private requireStopped(): SourceBackend {
    this.trust();
    if (!this.resources.backend || this.phase !== 'stopped')
      throw new Error('请先暂停程序，再查看 C 变量、寄存器或内存');
    return this.resources.backend;
  }
  private breakpointRuntime(): SourceBackend {
    this.trust();
    if (!this.resources.backend || !['stopped', 'configuring'].includes(this.phase))
      throw new Error('请先暂停程序，再修改断点');
    return this.resources.backend;
  }
  private async prepare(args: Record<string, unknown>): Promise<void> {
    this.trust();
    if (this.disposed) throw new Error('调试适配器已释放');
    this.launchArgs = args;
    this.stopOnEntry = args.stopOnEntry !== false;
    this.ended = false;
    this.phase = 'preparing';
    const epoch = ++this.epoch;
    const project = (this.project = await this.options.getProject());
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    if (!project.debug) throw new Error('C 源码调试需要在项目中配置 debug.elf');
    this.trust();
    await this.options.builder.build(
      project,
      (text) => this.output(text, 'stderr'),
      () => epoch !== this.epoch
    );
    await fs.access(project.debug.elf);
    this.trust();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    const { backend: runtime } = await this.resources.allocate(
      project,
      (text) => this.output(text, 'stdout'),
      () => {
        this.trust();
        if (epoch !== this.epoch) throw new Error('调试启动已取消');
      }
    );
    runtime.on('stopped', (event: SourceStoppedEvent) => {
      if (epoch !== this.epoch || this.phase === 'preparing' || this.phase === 'ended') return;
      if (this.internalPause) {
        this.internalStop = event;
        return;
      }
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
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.phase = 'configuring';
    for (const [file, lines] of this.sourceRequests.desiredSources)
      await this.bindings.replaceSource(file, lines);
    await this.bindings.replaceInstructions(this.machine.instructionAddresses());
    await this.bindings.replaceWatches(this.machine.dataPoints());
    await this.resources.connect();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.output('C 源码调试已就绪：ELF/DWARF、源码单步、调用栈、只读变量，以及机器级调试观察器。\n');
  }
  private async boot(): Promise<void> {
    const runtime = this.breakpointRuntime(),
      project = this.project!;
    const result = await runtime.breakpoints.insertEntry(project.debug?.entry);
    if (!result.id) throw new Error('无法为 ELF 入口设置硬件断点');
    this.bindings.entry = { number: result.id, address: result.address };
    this.phase = 'booting';
    await runtime.execution.execute('continue');
    this.event('continued', { threadId: 1, allThreadsContinued: true });
  }
  private async onStopped(event: SourceStoppedEvent): Promise<void> {
    if (!this.resources.backend || this.phase === 'ended') return;
    if (event.reason === 'exit') {
      await this.finish();
      return;
    }
    await this.values.expireVariables();
    this.phase = 'stopped';
    const number = event.breakpointId ?? '';
    const registers = await this.resources.backend.registers(),
      pc = instructionAddress(registers);
    const hitEntry =
      !!this.bindings.entry && (number === this.bindings.entry.number || pc === this.bindings.entry.address);
    if (hitEntry) {
      await this.bindings.deleteBindings(this.resources.backend.breakpoints, [this.bindings.entry!.number]);
      this.bindings.entry = undefined;
    }
    const watch = [...this.bindings.watches.values()].find((binding) => binding.number === number);
    const data = !!watch?.point || event.reason === 'data breakpoint';
    const sourceIds = [...this.bindings.sources.values()]
      .flat()
      .filter((binding) => binding.number === number || binding.address === pc)
      .map((binding) => binding.id);
    const ids =
      data && watch?.point
        ? this.machine.dataHits(watch.point.address, watch.point.access)
        : event.reason === 'breakpoint'
          ? [...sourceIds, ...this.machine.instructionHit(pc)]
          : [];
    if (watch?.point)
      this.lastDataHit = { address: watch.point.address, access: watch.point.access, ids, pc };
    if (hitEntry && !this.stopOnEntry && !ids.length && !data) {
      await this.motion('continue');
      return;
    }
    const reason = data ? 'data breakpoint' : hitEntry && !ids.length ? 'entry' : event.reason;
    this.output(
      `[暂停 ${reason}] ${hex(pc)}${event.functionName ? ` ${event.functionName}` : ''}${event.line ? ` 第 ${event.line} 行` : ''}\n`
    );
    this.event('stopped', {
      reason,
      threadId: 1,
      allThreadsStopped: true,
      description:
        data && watch?.point
          ? `数据断点 ${hex(watch.point.address)}（${watch.point.access}），访问已完成`
          : event.description || event.functionName || hex(pc),
      ...(ids.length ? { hitBreakpointIds: [...new Set(ids)] } : {})
    });
    this.event('invalidated', { areas: ['stacks', 'variables'] });
  }
  private async motion(command: SourceMotion): Promise<void> {
    const runtime = this.requireStopped();
    await this.values.expireVariables();
    this.phase = 'running';
    try {
      await runtime.execution.execute(command);
    } catch (error) {
      if (this.phase === 'running') this.phase = 'stopped';
      throw error;
    }
    this.event('continued', { threadId: 1, allThreadsContinued: true });
  }

  private async updateSourceBreakpoints(
    change: () => Promise<Map<number, Record<string, unknown>>>,
    report: (results: Map<number, Record<string, unknown>>) => void
  ): Promise<void> {
    const wasRunning = ['running', 'booting'].includes(this.phase),
      previous = this.phase;
    if (wasRunning) {
      this.internalPause = true;
      this.internalStop = undefined;
      try {
        await this.resources.backend!.execution.pause();
      } finally {
        this.internalPause = false;
      }
      this.phase = 'stopped';
    }
    let results: Map<number, Record<string, unknown>>;
    try {
      results = await change();
    } catch (error) {
      if (wasRunning && this.resources.backend && this.phase !== 'ended') {
        if (!this.options.isTrusted()) await this.finish();
        else await this.onStopped(this.internalStop ?? { reason: 'pause' });
      }
      this.internalStop = undefined;
      throw error;
    }

    report(results);
    if (wasRunning) {
      const stop = this.internalStop;
      this.internalStop = undefined;
      if (stop && stop.reason !== 'pause') await this.onStopped(stop);
      else {
        await this.motion('continue');
        if (previous === 'booting' && this.phase === 'running') this.phase = 'booting';
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
          supportsSetVariable: false,
          supportsDisassembleRequest: true,
          supportsInstructionBreakpoints: true,
          supportsDataBreakpoints: true,
          supportsSteppingGranularity: true,
          supportsVariablePaging: true
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
        if (!this.resources.backend?.capabilities) throw new Error('调试运行时尚未提供依赖报告');
        this.response(request, this.resources.backend.capabilities.snapshot());
        return;
      case 'threads':
        this.response(request, {
          threads: this.phase === 'ended' ? [] : [{ id: 1, name: 'CPU 0（C / ELF / DWARF）' }]
        });
        return;

      case 'continue':
        await this.motion('continue');
        this.response(request, { allThreadsContinued: true });
        return;
      case 'stepIn':
        await this.motion(args.granularity === 'instruction' ? 'instructionIn' : 'stepIn');
        this.response(request);
        return;
      case 'next':
        await this.motion(args.granularity === 'instruction' ? 'instructionOver' : 'stepOver');
        this.response(request);
        return;
      case 'stepOut':
        await this.motion('stepOut');
        this.response(request);
        return;
      case 'pause':
        this.trust();
        if (this.resources.backend && ['running', 'booting'].includes(this.phase))
          await this.resources.backend.execution.pause();
        this.response(request);
        return;

      case 'readMemory': {
        const address = machineAddress(machineAddress(args.memoryReference) + integer(args.offset, 0)),
          count = integer(args.count, 0);
        if (count < 0 || count > 4096) throw new Error('每次最多读取 4096 字节');
        this.response(request, {
          address: hex(address),
          data: (await this.requireStopped().readMemory(address, count)).toString('base64')
        });
        return;
      }

      case 'restart':
        if (this.ended) throw new Error('调试会话已结束，请重新启动调试');
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
        throw new Error(`当前 C 调试器不支持请求：${request.command}`);
    }
  }

  private async cleanup(): Promise<void> {
    ++this.epoch;
    this.values.clear();
    this.bindings.clear();
    this.lastDataHit = undefined;
    await releaseAll([() => this.resources.release(), () => this.options.builder.stop()]);
  }
  private finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.ended = true;
    this.phase = 'ended';
    return (this.finishing = this.cleanup().finally(() => {
      this.event('terminated');
    }));
  }
}
