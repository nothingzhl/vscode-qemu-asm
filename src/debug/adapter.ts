import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DebugAdapter, DebugProtocolMessage, Disposable, Event } from 'vscode';
import { build, Processes, Project } from '../core';
import { SourceMap, parseListing } from './listing';
import { SourceMaps } from './maps';
import { inspectDescriptors, inspectMemory } from './inspection';
import { disassemble } from './disassembly';
import { inspectPaging } from './paging';
import { MachineBreakpoints, machineAddress, memoryDataId, watchpoint } from './machineBreakpoints';
import { cpuMode, DebugRuntime, instructionAddress, stackAddress, stackWidth, StoppedEvent } from './runtime';

export interface DebugDisplay { readonly args: string[]; connect(): Promise<void>; dispose(): Promise<void> }
interface Request { seq: number; command: string; arguments?: Record<string, unknown> }
export interface AdapterOptions { getProject: () => Promise<Project>; isTrusted: () => boolean; log?: (text: string) => void; createDisplay?: () => Promise<DebugDisplay> }
interface Frame { id: number; name: string; line: number; column: number; instructionPointerReference: string; source?: { name: string; path: string } }
const hex = (value: number, digits = 4) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
function stackRange(registers: Record<string, number>): { lower: number; upper: number; pointerBytes: 2 | 4 } {
  const pointerBytes = stackWidth(registers), maximum = pointerBytes === 4 ? 0xffffffff : 0xffff;
  const expandDown = cpuMode(registers) !== 'real16' && !!((registers.ss_flags ?? 0) & (1 << 10));
  return { pointerBytes, lower: expandDown ? (registers.ss_limit ?? maximum) + 1 : 0, upper: expandDown ? maximum : Math.min(maximum, registers.ss_limit ?? maximum) };
}

/** VS Code 内联 DAP 适配器；同样可在 Node 集成测试中驱动，不模拟调试协议。 */
export class AssemblyDebugAdapter implements DebugAdapter {
  private events = new EventEmitter();
  readonly onDidSendMessage: Event<DebugProtocolMessage> = (listener, thisArgs?, disposables?) => {
    const fn = (message: DebugProtocolMessage) => listener.call(thisArgs, message);
    this.events.on('message', fn);
    const disposable: Disposable = { dispose: () => this.events.off('message', fn) };
    disposables?.push(disposable);
    return disposable;
  };
  private seq = 1;
  private queue: Promise<void> = Promise.resolve();
  private processes = new Processes();
  private runtime?: DebugRuntime;
  private display?: DebugDisplay;
  private map?: SourceMap;
  private maps?: SourceMaps;
  private sourceKey = '';
  private epoch = 0;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private userLines = new Map<string, number[]>();
  private userAddresses: number[] = [];
  private readonly machine = new MachineBreakpoints();
  private lastDataHit?: { address: number; access: 'read' | 'write' | 'readWrite'; ids: number[]; pc: number };
  private bootPending = false;
  private temporary?: number;
  private stopOnEntry = true;
  private internalPause = false;
  private internalStop?: StoppedEvent;
  private ended = false;
  private disposed = false;
  private finishing?: Promise<void>;
  private launchArgs: Record<string, unknown> = {};
  constructor(private readonly options: AdapterOptions) {}

  handleMessage(message: DebugProtocolMessage): void {
    if (this.disposed || (message as { type?: string }).type !== 'request') return;
    const request = message as unknown as Request;
    this.queue = this.queue.then(async () => {
      try { await this.dispatch(request); }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const inlineInspection = ['qemuAsm.inspectMemory', 'qemuAsm.inspectDescriptors', 'qemuAsm.inspectPaging', 'qemuAsm.disassemble'].includes(request.command);
        this.send({ type: 'response', request_seq: request.seq, command: request.command, success: false, message: text, body: { error: { id: 1, format: text, showUser: !inlineInspection } } });
        if (['launch', 'restart', 'configurationDone'].includes(request.command)) await this.finish();
      }
    });
  }

  async dispose(): Promise<void> { this.disposed = true; await this.finish(); await this.processes.dispose(); }

  private send(message: Record<string, unknown>): void { this.events.emit('message', { ...message, seq: this.seq++ } as unknown as DebugProtocolMessage); }
  private event(event: string, body: Record<string, unknown> = {}): void { this.send({ type: 'event', event, body }); }
  private response(request: Request, body: unknown = {}): void { this.send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body }); }
  private output(text: string, category = 'console'): void { this.options.log?.(text); this.event('output', { category, output: text }); }
  private trust(): void { if (!this.options.isTrusted()) throw new Error('请先信任工作区，才能启动或控制调试器'); }
  private requireStopped(): DebugRuntime {
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
      const result = await build(project, this.processes, text => this.output(text, 'stderr'), () => epoch !== this.epoch, listing);
      const maps: SourceMap[] = [];
      for (const unit of result.units) {
        if (!unit.listingPath) throw new Error('构建未生成调试 listing');
        const source = await fs.readFile(unit.source, 'utf8');
        const sourcePath = await fs.realpath(unit.source);
        maps.push(parseListing(await fs.readFile(unit.listingPath, 'utf8'), sourcePath, source, { loadAddress: unit.loadAddress, maxBytes: unit.size, initialBits: maps.length === 0 ? 16 : 'auto' }));
      }
      this.maps = new SourceMaps(maps);
      this.map = maps[0];
      this.sourceKey = await this.fileKey(this.map.sourcePath);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
    this.trust();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.userAddresses = this.addresses();
    const display = this.display = await this.options.createDisplay?.();
    if (epoch !== this.epoch) { await display?.dispose(); throw new Error('调试启动已取消'); }
    const runtime = this.runtime = new DebugRuntime(project, text => this.output(text, 'stdout'), display?.args);
    runtime.on('stopped', (event: StoppedEvent) => {
      if (epoch !== this.epoch || this.phase === 'preparing') return;
      if (this.internalPause) { this.internalStop = event; return; }
      const previousPhase = this.phase;
      // Record the physical stop before queued breakpoint requests can decide to resume.
      this.phase = 'stopped';
      this.queue = this.queue.then(async () => { if (epoch === this.epoch) await this.onStopped(event, previousPhase === 'booting'); }).catch(async error => { this.output(`${String(error)}\n`, 'stderr'); await this.finish(); });
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
    this.output('16/32 位引导调试已就绪。支持实模式、非 PAE 保护模式分页，以及寄存器、栈内存和 BP/EBP 栈帧链。\n');
  }

  private sourceMap(file: string): SourceMap | undefined { return this.maps?.forSource(file) ?? (file === this.sourceKey ? this.map : undefined); }
  private locate(address: number, bits?: 16 | 32): { map: SourceMap; entry: SourceMap['entries'][number] } | undefined {
    const entry = this.map?.forAddress(address);
    const located = this.maps?.forAddress(address) ?? (entry && this.map ? { map: this.map, entry } : undefined);
    return located && (bits === undefined || (located.entry.bits ?? 16) === bits) ? located : undefined;
  }
  /** NASM listings describe their original load addresses. A remapped virtual
   * address must not acquire unrelated source lines or instruction sizes. */
  private async locateLive(address: number, bits: 16 | 32, registers: Record<string, number>): Promise<ReturnType<AssemblyDebugAdapter['locate']>> {
    const located = this.locate(address, bits);
    if (!located || !((registers.cr0 ?? 0) & 0x80000000)) return located;
    const runtime = this.requireStopped();
    const firstAddress = located.entry.address;
    const lastAddress = firstAddress + located.entry.size - 1;
    if (lastAddress > 0xffffffff) return undefined;
    try {
      const first = await inspectPaging(runtime, { address: firstAddress });
      if (first.physicalAddress !== firstAddress) return undefined;
      if ((firstAddress >>> 12) !== (lastAddress >>> 12)) {
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
    return [...new Set([...this.userLines].flatMap(([file, lines]) => {
      const map = this.sourceMap(file);
      return lines.flatMap(line => { const entry = map?.forLine(line); return entry ? [entry.address] : []; });
    }))];
  }
  private async installBreakpoints(): Promise<void> {
    await this.runtime?.setBreakpoints([...new Set([...this.userAddresses, ...this.machine.instructionAddresses(), ...(this.temporary === undefined ? [] : [this.temporary])])]);
  }
  private async boot(): Promise<void> {
    if (!this.map || !this.runtime) throw new Error('调试器未启动');
    this.phase = 'booting'; this.bootPending = true; this.temporary = this.map.origin;
    await this.installBreakpoints();
    await this.runtime.resume();
  }
  private async onStopped(event: StoppedEvent, booting = false): Promise<void> {
    if (this.internalPause || !this.runtime || this.phase === 'ended') return;
    const temporary = this.temporary;
    this.phase = 'stopped';
    const registers = await this.runtime.registers();
    const mode = cpuMode(registers), bits = mode === 'protected32' ? 32 : 16;
    const pc = instructionAddress(registers);
    const entry = this.bootPending && pc === this.map?.origin;
    if (entry) this.bootPending = false;
    if (temporary !== undefined && !this.bootPending) { this.temporary = undefined; await this.installBreakpoints(); }
    const dataStop = event.reason === 'data breakpoint';
    if (entry && !dataStop && !this.stopOnEntry && !this.userAddresses.includes(pc) && !this.machine.instructionHit(pc).length) { await this.continue(false); return; }
    const reason = dataStop ? 'data breakpoint' : entry ? 'entry' : temporary === pc ? 'step' : event.reason;
    const hitIds = dataStop && event.dataAddress !== undefined ? this.machine.dataHits(event.dataAddress, event.dataAccess ?? 'readWrite') : event.reason === 'breakpoint' ? this.machine.instructionHit(pc) : [];
    if (dataStop && event.dataAddress !== undefined) this.lastDataHit = { address: event.dataAddress, access: event.dataAccess ?? 'readWrite', ids: hitIds, pc };
    const source = await this.locateLive(pc, bits, registers);
    const location = `${mode} ${hex(registers.cs)}:${hex(mode === 'real16' ? registers.eip & 0xffff : registers.eip, mode === 'real16' ? 4 : 8)} → ${hex(pc)}`;
    this.output(`[暂停 ${reason}] ${location}${source ? ` ${path.basename(source.map.sourcePath)} 第 ${source.entry.line} 行：${source.entry.text.trim()}` : '（当前地址无匹配代码模式的源码）'}\n`);
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, description: dataStop && event.dataAddress !== undefined ? `数据断点 ${hex(event.dataAddress)}（${event.dataAccess ?? 'readWrite'}）；访问已完成，${location}` : location, ...(hitIds.length ? { hitBreakpointIds: hitIds } : {}) });
    this.event('invalidated', { areas: ['stacks', 'variables'] });
  }
  private async continue(step: boolean): Promise<void> {
    const runtime = this.requireStopped();
    await runtime.resume(step);
    this.phase = 'running';
    this.event('continued', { threadId: 1, allThreadsContinued: true });
  }
  private async frames(): Promise<Frame[]> {
    const runtime = this.requireStopped();
    const registers = await runtime.registers();
    const bits = cpuMode(registers) === 'protected32' ? 32 : 16;
    const word = bits / 8;
    const { pointerBytes, lower, upper } = stackRange(registers);
    const maxSlot = upper - word * 2 + 1;
    const frames: Frame[] = [];
    const add = async (address: number, name: string) => {
      const located = await this.locateLive(address, bits, registers);
      frames.push({ id: frames.length + 1, name: `${name} ${hex(address)}`, line: located?.entry.line ?? 1, column: 1, instructionPointerReference: hex(address), ...(located ? { source: { name: path.basename(located.map.sourcePath), path: located.map.sourcePath } } : {}) });
    };
    await add(instructionAddress(registers), '当前指令');
    let bp = pointerBytes === 4 ? registers.ebp >>> 0 : registers.ebp & 0xffff;
    const sp = pointerBytes === 4 ? registers.esp >>> 0 : registers.esp & 0xffff;
    for (let count = 0; count < 15 && sp >= lower && bp >= sp && bp >= lower && bp > 0 && bp <= maxSlot; count++) {
      const address = stackAddress(registers, bp);
      if (address + word * 2 > 0x100000000) break;
      const words = await runtime.readMemory(address, word * 2);
      const previous = word === 4 ? words.readUInt32LE(0) : words.readUInt16LE(0);
      const returnOffset = word === 4 ? words.readUInt32LE(word) : words.readUInt16LE(word);
      const returnAddress = ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + returnOffset) >>> 0;
      const located = await this.locateLive(returnAddress, bits, registers);
      if (!located || located.entry.address !== returnAddress || (previous !== 0 && (previous <= bp || previous < lower || previous > maxSlot))) break;
      const call = located.map.entries.find(entry => entry.address + entry.size === returnAddress && (entry.bits ?? 16) === bits);
      if (!call) break;
      if (!await this.locateLive(call.address, bits, registers)) break;
      const opcode = await runtime.readMemory(call.address, Math.min(call.size, 2));
      if (opcode[0] !== 0xe8 && !(opcode[0] === 0xff && ((opcode[1] >> 3) & 7) === 2)) break;
      await add(returnAddress, bits === 32 ? '调用者（EBP 链）' : '调用者（BP 链）');
      if (previous === 0) break;
      bp = previous;
    }
    return frames;
  }
  private async variables(reference: number): Promise<unknown[]> {
    const runtime = this.requireStopped();
    const r = await runtime.registers();
    if (reference === 1) {
      const aliases: Record<string, number> = {};
      for (const [short, full] of [['ax','eax'],['bx','ebx'],['cx','ecx'],['dx','edx'],['si','esi'],['di','edi'],['bp','ebp'],['sp','esp'],['ip','eip']]) aliases[short] = r[full] & 0xffff;
      return Object.entries({ ...aliases, ...r }).map(([name, value]) => ({ name: name.toUpperCase(), value: hex(value, /^(?:e|cr)|_(?:base|limit|flags)$/.test(name) ? 8 : 4), type: '寄存器', variablesReference: name === 'eflags' ? 4 : 0, evaluateName: name, presentationHint: { attributes: ['readOnly'] } }));
    }
    if (reference === 4) return [['CF',0],['PF',2],['AF',4],['ZF',6],['SF',7],['TF',8],['IF',9],['DF',10],['OF',11]].map(([name, bit]) => ({ name: String(name), value: String((r.eflags >>> Number(bit)) & 1), variablesReference: 0, type: '标志位' }));
    if (reference === 2) {
      const width = cpuMode(r) === 'protected32' ? 4 : 2;
      const { pointerBytes: pointer, lower, upper } = stackRange(r);
      const sp = pointer === 4 ? r.esp >>> 0 : r.esp & 0xffff, ss = r.ss & 0xffff, address = stackAddress(r);
      const bytes = sp >= lower && sp <= upper ? await runtime.readMemory(address, Math.min(16 * width, upper - sp + 1, 0x100000000 - address)) : Buffer.alloc(0);
      const variables = [];
      for (let offset = 0; offset + width <= bytes.length; offset += width) variables.push({ name: `${hex(ss)}:${hex(sp + offset, pointer * 2)}${offset === 0 ? pointer === 4 ? ' ← ESP' : ' ← SP' : ''}`, value: hex(width === 4 ? bytes.readUInt32LE(offset) : bytes.readUInt16LE(offset), width * 2), type: `uint${width * 8}（小端）`, variablesReference: 0, memoryReference: hex(address + offset), presentationHint: { attributes: ['readOnly'] } });
      return variables;
    }
    if (reference === 3) return [{ name: '说明', value: '调用者来自 BP/EBP 栈帧链，未保存历史寄存器快照；寄存器和栈内存属于当前暂停的 CPU。', variablesReference: 0 }];
    if (reference === 5) return Object.entries({ MODE: cpuMode(r), '代码位数': cpuMode(r) === 'protected32' ? '32' : '16', '栈指针位数': String(stackWidth(r) * 8), '指令线性地址': hex(instructionAddress(r)), '栈线性地址': hex(stackAddress(r)), 'CR0.PE': String((r.cr0 ?? 0) & 1), 'CR0.PG': String((r.cr0 ?? 0) >>> 31), 'CR0.WP': String(((r.cr0 ?? 0) >>> 16) & 1), ...(r.cr3 === undefined ? {} : { CR3: hex(r.cr3, 8) }), ...(r.cr4 === undefined ? {} : { 'CR4.PAE': String((r.cr4 >>> 5) & 1), 'CR4.PSE': String((r.cr4 >>> 4) & 1) }) }).map(([name, value]) => ({ name, value, variablesReference: 0, presentationHint: { attributes: ['readOnly'] } }));
    return [];
  }

  private async dispatch(request: Request): Promise<void> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'initialize':
        this.response(request, { supportsConfigurationDoneRequest: true, supportsReadMemoryRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true, supportsRestartRequest: true, supportsStepBack: false, supportsSetVariable: false, supportsDisassembleRequest: true, supportsInstructionBreakpoints: true, supportsDataBreakpoints: true }); return;
      case 'launch':
        await this.prepare(args); this.response(request); this.event('initialized'); return;
      case 'configurationDone': await this.boot(); this.response(request); return;
      case 'threads': this.response(request, { threads: [{ id: 1, name: 'CPU 0（x86 16/32 位）' }] }); return;
      case 'setBreakpoints': {
        this.trust();
        const source = args.source as { path?: string } | undefined;
        const file = source?.path ? await this.fileKey(source.path) : '';
        const breakpoints = Array.isArray(args.breakpoints) ? args.breakpoints as { line?: number; condition?: string; hitCondition?: string; logMessage?: string }[] : [];
        const valid = breakpoints.filter(b => !b.condition && !b.hitCondition && !b.logMessage);
        this.userLines.set(file, valid.map(b => integer(b.line, 0)));
        this.userAddresses = this.addresses();
        const previousPhase = this.phase;
        const wasRunning = previousPhase === 'running' || previousPhase === 'booting';
        if (wasRunning && this.runtime) {
          this.internalStop = undefined; this.internalPause = true;
          try { await this.runtime.pause(); } finally { this.internalPause = false; }
          this.phase = 'stopped';
        }
        if (this.runtime && this.phase !== 'preparing') await this.installBreakpoints();
        this.response(request, { breakpoints: breakpoints.map(b => {
          const entry = !b.condition && !b.hitCondition && !b.logMessage ? this.sourceMap(file)?.forLine(integer(b.line, 0)) : undefined;
          return { verified: !!entry, line: b.line, ...(entry ? { instructionReference: hex(entry.address) } : { message: '仅支持项目已配置阶段中可执行指令行的普通断点；标签、数据和条件断点不支持。' }) };
        }) });
        if (wasRunning) {
          const natural = this.internalStop as StoppedEvent | undefined;
          this.internalStop = undefined;
          if (natural && natural.reason !== 'pause') await this.onStopped(natural, previousPhase === 'booting');
          else { await this.continue(false); if (previousPhase === 'booting') this.phase = 'booting'; }
        }
        return;
      }
      case 'stackTrace': {
        // VS Code can queue a previous stop's stack refresh behind continue or
        // restart. The old frames have expired; never read a running CPU for it.
        this.trust();
        if (this.phase !== 'stopped') { this.response(request, { stackFrames: [], totalFrames: 0 }); return; }
        const all = await this.frames(), start = Math.max(0, integer(args.startFrame, 0)), levels = integer(args.levels, all.length) || all.length;
        this.response(request, { stackFrames: all.slice(start, start + levels), totalFrames: all.length }); return;
      }
      case 'scopes':
        this.trust();
        if (this.phase !== 'stopped') { this.response(request, { scopes: [] }); return; }
        this.response(request, { scopes: integer(args.frameId, 1) === 1 ? [{ name: '寄存器', variablesReference: 1, expensive: false }, { name: '栈内存 SS:SP / SS:ESP', variablesReference: 2, expensive: false }, { name: 'CPU 模式与地址', variablesReference: 5, expensive: false }] : [{ name: '调用者信息', variablesReference: 3, expensive: false }] }); return;
      case 'variables':
        this.trust();
        this.response(request, { variables: this.phase === 'stopped' ? await this.variables(integer(args.variablesReference, 0)) : [] }); return;
      case 'continue': await this.continue(false); this.response(request, { allThreadsContinued: true }); return;
      case 'stepIn': await this.continue(true); this.response(request); return;
      case 'next': {
        const runtime = this.requireStopped(); const registers = await runtime.registers(); const address = instructionAddress(registers);
        const mapped = (await this.locateLive(address, cpuMode(registers) === 'protected32' ? 32 : 16, registers))?.entry;
        const decoded = mapped ? undefined : (await disassemble(runtime, { address, count: 1 })).instructions[0];
        const entry = mapped ?? (decoded && decoded.presentationHint !== 'invalid' && decoded.size > 0 ? { address, size: decoded.size } : undefined);
        const bytes = await runtime.readMemory(address, entry?.size ?? 1);
        let opcode = 0;
        while ([0x26,0x2e,0x36,0x3e,0x64,0x65,0x66,0x67,0xf0,0xf2,0xf3].includes(bytes[opcode]) && opcode < bytes.length - 1) opcode++;
        const call = [0xe8,0x9a,0xcd].includes(bytes[opcode]) || (bytes[opcode] === 0xff && [2,3].includes((bytes[opcode + 1] >> 3) & 7));
        if (entry && call) { this.temporary = entry.address + entry.size; await this.installBreakpoints(); await this.continue(false); }
        else await this.continue(true);
        this.response(request); return;
      }
      case 'stepOut': {
        const frames = await this.frames(); if (frames.length < 2) throw new Error('没有可验证的 BP 调用者栈帧，无法执行跳出');
        this.temporary = Number(frames[1].instructionPointerReference); await this.installBreakpoints(); await this.continue(false); this.response(request); return;
      }
      case 'pause': this.trust(); await this.runtime?.pause(); this.response(request); return;
      case 'disassemble': {
        const result = await disassemble(this.requireStopped(), args); this.response(request, { instructions: result.instructions }); return;
      }
      case 'qemuAsm.disassemble':
        this.response(request, { ...await disassemble(this.requireStopped(), args), breakpoints: this.machine.instructions().breakpoints }); return;
      case 'setInstructionBreakpoints': {
        const runtime = this.breakpointRuntime();
        const breakpoints = await this.machine.setNativeInstructions(args.breakpoints ?? [], addresses => runtime.setBreakpoints(this.executionAddresses(addresses)));
        this.response(request, { breakpoints }); return;
      }
      case 'qemuAsm.instructionBreakpoints': {
        const runtime = this.requireStopped();
        this.response(request, await this.machine.changeInstruction(args, addresses => runtime.setBreakpoints(this.executionAddresses(addresses)))); return;
      }
      case 'dataBreakpointInfo': {
        const runtime = this.requireStopped();
        let address: number, size: number;
        try {
          if (args.memoryReference !== undefined) { address = machineAddress(args.memoryReference); size = args.bytes === undefined ? 1 : Number(args.bytes); }
          else if (args.variablesReference === 2 && typeof args.name === 'string' && /^0x[0-9a-f]+:0x[0-9a-f]+(?: ← (?:E?SP))?$/i.test(args.name)) {
            const r = await runtime.registers(); address = stackAddress(r, Number(/^0x[0-9a-f]+:(0x[0-9a-f]+)/i.exec(args.name)![1])); size = cpuMode(r) === 'protected32' ? 4 : 2;
          } else { address = machineAddress(args.name); size = args.bytes === undefined ? 1 : Number(args.bytes); }
          const point = watchpoint({ address, size, access: 'write' });
          this.response(request, { dataId: memoryDataId(point.address, point.size), description: `${hex(point.address)} · ${point.size} 字节`, accessTypes: ['read', 'write', 'readWrite'], canPersist: true });
        } catch (error) { this.response(request, { dataId: null, description: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      case 'setDataBreakpoints': {
        const runtime = this.breakpointRuntime();
        this.response(request, { breakpoints: await this.machine.setNativeWatches(args.breakpoints ?? [], points => runtime.setDataBreakpoints(points)) }); return;
      }
      case 'qemuAsm.watchpoints': {
        const runtime = this.requireStopped();
        this.response(request, { ...await this.machine.changeWatch(args, points => runtime.setDataBreakpoints(points)), ...(this.lastDataHit ? { lastHit: this.lastDataHit } : {}) }); return;
      }
      case 'qemuAsm.inspectMemory':
        this.response(request, await inspectMemory(this.requireStopped(), args)); return;
      case 'qemuAsm.inspectDescriptors':
        this.response(request, await inspectDescriptors(this.requireStopped(), args)); return;
      case 'qemuAsm.inspectPaging':
        this.response(request, await inspectPaging(this.requireStopped(), args)); return;
      case 'readMemory': {
        const address = this.address(String(args.memoryReference ?? '')) + integer(args.offset, 0); const count = integer(args.count, 0);
        if (count < 0 || count > 4096) throw new Error('每次最多读取 4096 字节');
        const data = await this.requireStopped().readMemory(address, count);
        this.response(request, { address: hex(address), data: data.toString('base64') }); return;
      }
      case 'evaluate': {
        this.trust();
        if (this.phase !== 'stopped') { this.response(request, { result: 'CPU 未暂停；暂停后更新', variablesReference: 0 }); return; }
        if (integer(args.frameId, 1) !== 1) throw new Error('调用者没有历史寄存器快照，请选择当前指令栈帧查看');
        const runtime = this.requireStopped(); const r = await runtime.registers(); const expression = String(args.expression ?? '').trim().replace(/^\$/, '').toLowerCase();
        let value: number;
        const aliases: Record<string, string> = { ax:'eax', bx:'ebx', cx:'ecx', dx:'edx', si:'esi', di:'edi', bp:'ebp', sp:'esp', ip:'eip', flags:'eflags' };
        if (expression === 'mode') { this.response(request, { result: cpuMode(r), variablesReference: 0 }); return; }
        if (expression === 'cs:ip' || expression === 'cs:eip') value = instructionAddress(r);
        else if (expression === 'ss:sp' || expression === 'ss:esp') value = stackAddress(r);
        else if (/^dword\[(?:0x[0-9a-f]+|\d+)\]$/.test(expression)) value = (await runtime.readMemory(this.address(expression.slice(6, -1)), 4)).readUInt32LE(0);
        else if (/^\[(?:0x[0-9a-f]+|\d+)\]$/.test(expression)) value = (await runtime.readMemory(this.address(expression.slice(1, -1)), 2)).readUInt16LE(0);
        else if (expression in aliases) value = r[aliases[expression]] & 0xffff;
        else if (Object.prototype.hasOwnProperty.call(r, expression)) value = r[expression];
        else throw new Error('可查看寄存器、MODE、CS:EIP、SS:ESP、[0x地址] 的 16 位值或 dword[0x地址] 的 32 位值');
        this.response(request, { result: hex(value), variablesReference: 0, memoryReference: ['ss:sp','ss:esp','cs:ip','cs:eip'].includes(expression) ? hex(value) : undefined }); return;
      }
      case 'restart':
        if (this.ended) { await this.finish(); throw new Error('调试会话已结束，请重新启动调试'); }
        await this.cleanup(); await this.prepare(this.launchArgs); await this.boot(); this.response(request); return;
      case 'disconnect': case 'terminate': this.response(request); await this.finish(); return;
      case 'setExceptionBreakpoints': this.response(request, { breakpoints: [] }); return;
      default: throw new Error(`当前调试器不支持请求：${request.command}`);
    }
  }
  private executionAddresses(instructions = this.machine.instructionAddresses()): number[] {
    return [...new Set([...this.userAddresses, ...instructions, ...(this.temporary === undefined ? [] : [this.temporary])])];
  }
  private breakpointRuntime(): DebugRuntime {
    this.trust();
    if (!this.runtime || !['stopped', 'configuring'].includes(this.phase)) throw new Error('请先暂停程序，再修改断点');
    return this.runtime;
  }
  private async fileKey(file: string): Promise<string> {
    let canonical = path.normalize(file);
    try { canonical = await fs.realpath(file); } catch { /* Unknown source files remain unverified. */ }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }
  private address(text: string): number { if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error('内存地址必须为十进制或 0x 十六进制'); return Number(text); }
  private async cleanup(): Promise<void> {
    ++this.epoch;
    const runtime = this.runtime; this.runtime = undefined;
    const display = this.display; this.display = undefined;
    await Promise.all([runtime?.dispose(), display?.dispose(), this.processes.stop()]);
    this.temporary = undefined; this.bootPending = false; this.lastDataHit = undefined;
  }
  private finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.ended = true;
    this.phase = 'ended';
    this.finishing = this.cleanup().then(() => { this.event('terminated'); });
    return this.finishing;
  }
}
