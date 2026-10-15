import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DebugAdapter, DebugProtocolMessage } from 'vscode';
import { AssemblyFrames } from '../../application/assembly/frames';
import { AssemblyVariables } from '../../application/assembly/variables';
import { disassemble } from '../../application/disassembly';
import { SourceMap, parseListing } from '../../debug/listing';
import { MachineBreakpoints } from '../../debug/machineBreakpoints';
import { SourceMaps } from '../../debug/maps';
import { inspectPaging } from '../../debug/paging';
import { cpuMode, instructionAddress } from '../../domain/x86/state';
import type { StoppedEvent } from '../../ports/machine';
import { AssemblyViewRequests } from './assemblyViews';
import { DapChannel } from './channel';
import { InspectionRequests } from './inspectionRequests';
import { MachineRequests } from './machineRequests';

import type { AssemblyBackend } from '../../ports/machine';
import type { DebugDisplay } from '../../ports/presentation';
import type { SessionOptions } from '../../ports/session';
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
  private runtime?: AssemblyBackend;
  private display?: DebugDisplay;
  private map?: SourceMap;
  private maps?: SourceMaps;
  private sourceKey = '';
  private epoch = 0;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private userLines = new Map<string, number[]>();
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
  private readonly framesView = new AssemblyFrames(
    () => this.requireStopped(),
    (at, bits, registers) => this.locateLive(at, bits, registers)
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
  private readonly inspections: InspectionRequests;
  constructor(private readonly options: SessionOptions<AssemblyBackend>) {
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
    await this.finish();
    await this.options.builder.dispose();
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
    if (!this.runtime || this.phase !== 'stopped') throw new Error('请先暂停程序，再查看寄存器或栈内存');
    return this.runtime;
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
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu asm debug '));
    try {
      const listing = path.join(temp, 'boot.lst');
      this.trust();
      const result = await this.options.builder.build(
        project,
        (text) => this.output(text, 'stderr'),
        () => epoch !== this.epoch,
        listing
      );
      const maps: SourceMap[] = [];
      for (const unit of result.units) {
        if (!unit.listingPath) throw new Error('构建未生成调试 listing');
        const source = await fs.readFile(unit.source, 'utf8');
        const sourcePath = await fs.realpath(unit.source);
        maps.push(
          parseListing(await fs.readFile(unit.listingPath, 'utf8'), sourcePath, source, {
            loadAddress: unit.loadAddress,
            maxBytes: unit.size,
            initialBits: maps.length === 0 ? 16 : 'auto'
          })
        );
      }
      this.maps = new SourceMaps(maps);
      this.map = maps[0];
      this.sourceKey = await this.fileKey(this.map.sourcePath);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
    this.trust();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.userAddresses = this.addresses();
    const resources = await this.options.createResources(project, (text) => this.output(text, 'stdout'));
    if (epoch !== this.epoch) {
      await Promise.all([resources.backend.dispose(), resources.display?.dispose()]);
      throw new Error('调试启动已取消');
    }
    const display = (this.display = resources.display);
    const runtime = (this.runtime = resources.backend);
    display?.observeCapabilities?.(runtime.capabilities);
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
        .catch(async (error) => {
          this.output(`${String(error)}\n`, 'stderr');
          await this.finish();
        });
    });
    runtime.on('terminated', (result: { error?: string }) => {
      if (epoch !== this.epoch) return;
      if (result.error) this.output(`${result.error}\n`, 'stderr');
      void this.finish();
    });
    await runtime.launch();
    if (this.machine.dataPoints().length) await runtime.setDataBreakpoints(this.machine.dataPoints());
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    await display?.connect();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.phase = 'configuring';
    this.output(
      '16/32 位引导调试已就绪。支持实模式、非 PAE 保护模式分页，以及寄存器、栈内存和 BP/EBP 栈帧链。\n'
    );
  }

  private sourceMap(file: string): SourceMap | undefined {
    return this.maps?.forSource(file) ?? (file === this.sourceKey ? this.map : undefined);
  }
  private locate(
    address: number,
    bits?: 16 | 32
  ): { map: SourceMap; entry: SourceMap['entries'][number] } | undefined {
    const entry = this.map?.forAddress(address);
    const located =
      this.maps?.forAddress(address) ?? (entry && this.map ? { map: this.map, entry } : undefined);
    return located && (bits === undefined || (located.entry.bits ?? 16) === bits) ? located : undefined;
  }
  /** NASM listings describe their original load addresses. A remapped virtual
   * address must not acquire unrelated source lines or instruction sizes. */
  private async locateLive(
    address: number,
    bits: 16 | 32,
    registers: Record<string, number>
  ): Promise<ReturnType<AssemblyDapAdapter['locate']>> {
    const located = this.locate(address, bits);
    if (!located || !((registers.cr0 ?? 0) & 0x80000000)) return located;
    const runtime = this.requireStopped();
    const firstAddress = located.entry.address;
    const lastAddress = firstAddress + located.entry.size - 1;
    if (lastAddress > 0xffffffff) return undefined;
    try {
      const first = await inspectPaging(runtime, { address: firstAddress });
      if (first.physicalAddress !== firstAddress) return undefined;
      if (firstAddress >>> 12 !== lastAddress >>> 12) {
        const last = await inspectPaging(runtime, { address: lastAddress });
        if (last.physicalAddress !== lastAddress) return undefined;
      }
    } catch (error) {
      // Older QEMU can still debug virtual machine code without the optional
      // physical-memory extension. Unverified source mapping stays absent.
      if (this.runtime !== runtime || this.phase !== 'stopped') throw error;
      return undefined;
    }
    return located;
  }
  private addresses(): number[] {
    return [
      ...new Set(
        [...this.userLines].flatMap(([file, lines]) => {
          const map = this.sourceMap(file);
          return lines.flatMap((line) => {
            const entry = map?.forLine(line);
            return entry ? [entry.address] : [];
          });
        })
      )
    ];
  }
  private async installBreakpoints(): Promise<void> {
    await this.runtime?.setBreakpoints([
      ...new Set([
        ...this.userAddresses,
        ...this.machine.instructionAddresses(),
        ...(this.temporary === undefined ? [] : [this.temporary])
      ])
    ]);
  }
  private async boot(): Promise<void> {
    if (!this.map || !this.runtime) throw new Error('调试器未启动');
    this.phase = 'booting';
    this.bootPending = true;
    this.temporary = this.map.origin;
    await this.installBreakpoints();
    await this.runtime.resume();
  }
  private async onStopped(event: StoppedEvent): Promise<void> {
    if (this.internalPause || !this.runtime || this.phase === 'ended') return;
    const temporary = this.temporary;
    this.phase = 'stopped';
    const registers = await this.runtime.registers();
    const mode = cpuMode(registers),
      bits = mode === 'protected32' ? 32 : 16;
    const pc = instructionAddress(registers);
    const entry = this.bootPending && pc === this.map?.origin;
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
    const source = await this.locateLive(pc, bits, registers);
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

  private async dispatch(request: Request): Promise<void> {
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
        if (!this.runtime) throw new Error('调试运行时尚未启动');
        this.response(request, this.runtime.capabilities.snapshot());
        return;
      case 'threads':
        this.response(request, { threads: [{ id: 1, name: 'CPU 0（x86 16/32 位）' }] });
        return;
      case 'setBreakpoints': {
        this.trust();
        const source = args.source as { path?: string } | undefined;
        const file = source?.path ? await this.fileKey(source.path) : '';
        const breakpoints = Array.isArray(args.breakpoints)
          ? (args.breakpoints as {
              line?: number;
              condition?: string;
              hitCondition?: string;
              logMessage?: string;
            }[])
          : [];
        const valid = breakpoints.filter((b) => !b.condition && !b.hitCondition && !b.logMessage);
        this.userLines.set(
          file,
          valid.map((b) => integer(b.line, 0))
        );
        this.userAddresses = this.addresses();
        const previousPhase = this.phase;
        const wasRunning = previousPhase === 'running' || previousPhase === 'booting';
        if (wasRunning && this.runtime) {
          this.internalStop = undefined;
          this.internalPause = true;
          try {
            await this.runtime.pause();
          } finally {
            this.internalPause = false;
          }
          this.phase = 'stopped';
        }
        if (this.runtime && this.phase !== 'preparing') await this.installBreakpoints();
        this.response(request, {
          breakpoints: breakpoints.map((b) => {
            const entry =
              !b.condition && !b.hitCondition && !b.logMessage
                ? this.sourceMap(file)?.forLine(integer(b.line, 0))
                : undefined;
            return {
              verified: !!entry,
              line: b.line,
              ...(entry
                ? { instructionReference: hex(entry.address) }
                : { message: '仅支持项目已配置阶段中可执行指令行的普通断点；标签、数据和条件断点不支持。' })
            };
          })
        });
        if (wasRunning) {
          const natural = this.internalStop as StoppedEvent | undefined;
          this.internalStop = undefined;
          if (natural && natural.reason !== 'pause') await this.onStopped(natural);
          else {
            await this.continue(false);
            if (previousPhase === 'booting') this.phase = 'booting';
          }
        }
        return;
      }

      case 'continue':
        await this.continue(false);
        this.response(request, { allThreadsContinued: true });
        return;
      case 'stepIn':
        await this.continue(true);
        this.response(request);
        return;
      case 'next': {
        const runtime = this.requireStopped();
        const registers = await runtime.registers();
        const address = instructionAddress(registers);
        const mapped = (
          await this.locateLive(address, cpuMode(registers) === 'protected32' ? 32 : 16, registers)
        )?.entry;
        const decoded = mapped
          ? undefined
          : (await disassemble(runtime, { address, count: 1 }, this.options.decoder)).instructions[0];
        const entry =
          mapped ??
          (decoded && decoded.presentationHint !== 'invalid' && decoded.size > 0
            ? { address, size: decoded.size }
            : undefined);
        const bytes = await runtime.readMemory(address, entry?.size ?? 1);
        let opcode = 0;
        while (
          [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3].includes(bytes[opcode]) &&
          opcode < bytes.length - 1
        )
          opcode++;
        const call =
          [0xe8, 0x9a, 0xcd].includes(bytes[opcode]) ||
          (bytes[opcode] === 0xff && [2, 3].includes((bytes[opcode + 1] >> 3) & 7));
        if (entry && call) {
          this.temporary = entry.address + entry.size;
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
        await this.runtime?.pause();
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
    if (!this.runtime || !['stopped', 'configuring'].includes(this.phase))
      throw new Error('请先暂停程序，再修改断点');
    return this.runtime;
  }
  private async fileKey(file: string): Promise<string> {
    let canonical = path.normalize(file);
    try {
      canonical = await fs.realpath(file);
    } catch {
      /* Unknown source files remain unverified. */
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }
  private address(text: string): number {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error('内存地址必须为十进制或 0x 十六进制');
    return Number(text);
  }
  private async cleanup(): Promise<void> {
    ++this.epoch;
    const runtime = this.runtime;
    this.runtime = undefined;
    const display = this.display;
    this.display = undefined;
    await Promise.all([runtime?.dispose(), display?.dispose(), this.options.builder.stop()]);
    this.temporary = undefined;
    this.bootPending = false;
    this.lastDataHit = undefined;
  }
  private finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.ended = true;
    this.phase = 'ended';
    this.finishing = this.cleanup().then(() => {
      this.event('terminated');
    });
    return this.finishing;
  }
}
