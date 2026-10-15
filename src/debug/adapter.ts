import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DebugAdapter, DebugProtocolMessage, Disposable, Event } from 'vscode';
import { build, Processes, Project } from '../core';
import { SourceMap, parseListing } from './listing';
import { DebugRuntime, realModeAddress, StoppedEvent } from './runtime';

interface Request { seq: number; command: string; arguments?: Record<string, unknown> }
export interface AdapterOptions { getProject: () => Promise<Project>; isTrusted: () => boolean; log?: (text: string) => void }
interface Frame { id: number; name: string; line: number; column: number; instructionPointerReference: string; source?: { name: string; path: string } }
const hex = (value: number, digits = 4) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;

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
  private map?: SourceMap;
  private sourceKey = '';
  private epoch = 0;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private userLines = new Map<string, number[]>();
  private userAddresses: number[] = [];
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
        this.send({ type: 'response', request_seq: request.seq, command: request.command, success: false, message: text, body: { error: { id: 1, format: text, showUser: true } } });
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
    this.phase = 'preparing';
    const epoch = ++this.epoch;
    const project = await this.options.getProject();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu asm debug '));
    try {
      const listing = path.join(temp, 'boot.lst');
      this.trust();
      await build(project, this.processes, text => this.output(text, 'stderr'), () => epoch !== this.epoch, listing);
      const source = await fs.readFile(project.source, 'utf8');
      const sourcePath = await fs.realpath(project.source);
      this.map = parseListing(await fs.readFile(listing, 'utf8'), sourcePath, source);
      this.sourceKey = await this.fileKey(sourcePath);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
    this.trust();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.userAddresses = this.addresses();
    const runtime = this.runtime = new DebugRuntime(project, text => this.output(text, 'stdout'));
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
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.phase = 'configuring';
    this.output('16 位实模式调试已就绪。暂停后可查看寄存器、SS:SP 栈内存和 BP 栈帧链。\n');
  }

  private addresses(): number[] {
    if (!this.map) return [];
    const lines = this.userLines.get(this.sourceKey) ?? [];
    return [...new Set(lines.flatMap(line => { const entry = this.map?.forLine(line); return entry ? [entry.address] : []; }))];
  }
  private async installBreakpoints(): Promise<void> {
    await this.runtime?.setBreakpoints([...new Set([...this.userAddresses, ...(this.temporary === undefined ? [] : [this.temporary])])]);
  }
  private async boot(): Promise<void> {
    if (!this.map || !this.runtime) throw new Error('调试器未启动');
    this.phase = 'booting'; this.temporary = this.map.origin;
    await this.installBreakpoints();
    await this.runtime.resume();
  }
  private async onStopped(event: StoppedEvent, booting = false): Promise<void> {
    if (this.internalPause || !this.runtime || this.phase === 'ended') return;
    const temporary = this.temporary;
    this.phase = 'stopped';
    const registers = await this.runtime.registers();
    const pc = realModeAddress(registers);
    if (temporary !== undefined) { this.temporary = undefined; await this.installBreakpoints(); }
    if (booting && (!this.map || pc !== this.map.origin)) throw new Error(`未能停在引导入口，实际地址 ${hex(pc)}`);
    if (booting && !this.stopOnEntry && !this.userAddresses.includes(pc)) { await this.continue(false); return; }
    const reason = booting ? 'entry' : temporary === pc ? 'step' : event.reason;
    const source = this.map?.forAddress(pc);
    this.output(`[暂停 ${reason}] ${hex(registers.cs)}:${hex(registers.eip & 0xffff)} → ${hex(pc)}${source ? ` 第 ${source.line} 行：${source.text.trim()}` : '（当前地址不在引导源码中）'}\n`);
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, description: `${hex(registers.cs)}:${hex(registers.eip & 0xffff)} → ${hex(pc)}` });
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
    const frames: Frame[] = [];
    const add = (address: number, name: string) => {
      const entry = this.map?.forAddress(address);
      frames.push({ id: frames.length + 1, name: `${name} ${hex(address)}`, line: entry?.line ?? 1, column: 1, instructionPointerReference: hex(address), ...(entry && this.map ? { source: { name: path.basename(this.map.sourcePath), path: this.map.sourcePath } } : {}) });
    };
    add(realModeAddress(registers), '当前指令');
    let bp = registers.ebp & 0xffff;
    const sp = registers.esp & 0xffff;
    const segment = (registers.ss & 0xffff) * 16;
    for (let count = 0; count < 15 && bp >= sp && bp > 0 && bp <= 0xfffc; count++) {
      const words = await runtime.readMemory(segment + bp, 4);
      const previous = words.readUInt16LE(0);
      const returnAddress = (registers.cs & 0xffff) * 16 + words.readUInt16LE(2);
      const returnEntry = this.map?.forAddress(returnAddress);
      if (!returnEntry || returnEntry.address !== returnAddress || (previous !== 0 && (previous <= bp || previous > 0xfffc))) break;
      const call = this.map?.entries.find(entry => entry.address + entry.size === returnAddress);
      if (!call) break;
      const opcode = await runtime.readMemory(call.address, Math.min(call.size, 2));
      if (opcode[0] !== 0xe8 && !(opcode[0] === 0xff && ((opcode[1] >> 3) & 7) === 2)) break;
      add(returnAddress, '调用者（BP 链）');
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
      return Object.entries({ ...aliases, ...r }).map(([name, value]) => ({ name: name.toUpperCase(), value: hex(value, name.startsWith('e') || name === 'cr0' ? 8 : 4), type: '寄存器', variablesReference: name === 'eflags' ? 4 : 0, evaluateName: name, presentationHint: { attributes: ['readOnly'] } }));
    }
    if (reference === 4) return [['CF',0],['PF',2],['AF',4],['ZF',6],['SF',7],['TF',8],['IF',9],['DF',10],['OF',11]].map(([name, bit]) => ({ name: String(name), value: String((r.eflags >>> Number(bit)) & 1), variablesReference: 0, type: '标志位' }));
    if (reference === 2) {
      const sp = r.esp & 0xffff, ss = r.ss & 0xffff, address = ss * 16 + sp;
      const bytes = await runtime.readMemory(address, Math.min(32, 0x10000 - sp));
      const variables = [];
      for (let offset = 0; offset + 1 < bytes.length; offset += 2) variables.push({ name: `${hex(ss)}:${hex(sp + offset)}${offset === 0 ? ' ← SP' : ''}`, value: hex(bytes.readUInt16LE(offset)), type: 'uint16（小端）', variablesReference: 0, memoryReference: hex(address + offset), presentationHint: { attributes: ['readOnly'] } });
      return variables;
    }
    if (reference === 3) return [{ name: '说明', value: '调用者来自 BP 栈帧链，未保存历史寄存器快照；寄存器和栈内存属于当前暂停的 CPU。', variablesReference: 0 }];
    return [];
  }

  private async dispatch(request: Request): Promise<void> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'initialize':
        this.response(request, { supportsConfigurationDoneRequest: true, supportsReadMemoryRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true, supportsRestartRequest: true, supportsStepBack: false, supportsSetVariable: false }); return;
      case 'launch':
        await this.prepare(args); this.response(request); this.event('initialized'); return;
      case 'configurationDone': await this.boot(); this.response(request); return;
      case 'threads': this.response(request, { threads: [{ id: 1, name: 'CPU 0（16 位实模式）' }] }); return;
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
          const entry = !b.condition && !b.hitCondition && !b.logMessage && this.map && file === this.sourceKey ? this.map.forLine(integer(b.line, 0)) : undefined;
          return { verified: !!entry, line: b.line, ...(entry ? { instructionReference: hex(entry.address) } : { message: '仅支持当前单文件内可执行指令行的普通断点；标签、数据和条件断点不支持。' }) };
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
        const all = await this.frames(), start = Math.max(0, integer(args.startFrame, 0)), levels = integer(args.levels, all.length) || all.length;
        this.response(request, { stackFrames: all.slice(start, start + levels), totalFrames: all.length }); return;
      }
      case 'scopes':
        this.requireStopped();
        this.response(request, { scopes: integer(args.frameId, 1) === 1 ? [{ name: '寄存器', variablesReference: 1, expensive: false }, { name: '栈内存 SS:SP', variablesReference: 2, expensive: false }] : [{ name: '调用者信息', variablesReference: 3, expensive: false }] }); return;
      case 'variables': this.response(request, { variables: await this.variables(integer(args.variablesReference, 0)) }); return;
      case 'continue': await this.continue(false); this.response(request, { allThreadsContinued: true }); return;
      case 'stepIn': await this.continue(true); this.response(request); return;
      case 'next': {
        const runtime = this.requireStopped(); const registers = await runtime.registers(); const address = realModeAddress(registers);
        const entry = this.map?.forAddress(address); const bytes = await runtime.readMemory(address, entry?.size ?? 1);
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
      case 'readMemory': {
        const address = this.address(String(args.memoryReference ?? '')) + integer(args.offset, 0); const count = integer(args.count, 0);
        if (count < 0 || count > 4096) throw new Error('每次最多读取 4096 字节');
        const data = await this.requireStopped().readMemory(address, count);
        this.response(request, { address: hex(address), data: data.toString('base64') }); return;
      }
      case 'evaluate': {
        if (integer(args.frameId, 1) !== 1) throw new Error('调用者没有历史寄存器快照，请选择当前指令栈帧查看');
        const runtime = this.requireStopped(); const r = await runtime.registers(); const expression = String(args.expression ?? '').trim().replace(/^\$/, '').toLowerCase();
        let value: number;
        const aliases: Record<string, string> = { ax:'eax', bx:'ebx', cx:'ecx', dx:'edx', si:'esi', di:'edi', bp:'ebp', sp:'esp', ip:'eip', flags:'eflags' };
        if (expression === 'cs:ip') value = realModeAddress(r);
        else if (expression === 'ss:sp') value = (r.ss & 0xffff) * 16 + (r.esp & 0xffff);
        else if (/^\[(?:0x[0-9a-f]+|\d+)\]$/.test(expression)) value = (await runtime.readMemory(this.address(expression.slice(1, -1)), 2)).readUInt16LE(0);
        else if (expression in aliases) value = r[aliases[expression]] & 0xffff;
        else if (Object.prototype.hasOwnProperty.call(r, expression)) value = r[expression];
        else throw new Error('可查看寄存器（如 AX、EIP）、CS:IP、SS:SP 或 [0x地址] 的 16 位内存值');
        this.response(request, { result: hex(value), variablesReference: 0, memoryReference: ['ss:sp','cs:ip'].includes(expression) ? hex(value) : undefined }); return;
      }
      case 'restart':
        if (this.ended) { await this.finish(); throw new Error('调试会话已结束，请重新启动调试'); }
        await this.cleanup(); await this.prepare(this.launchArgs); await this.boot(); this.response(request); return;
      case 'disconnect': case 'terminate': this.response(request); await this.finish(); return;
      case 'setExceptionBreakpoints': this.response(request, { breakpoints: [] }); return;
      default: throw new Error(`当前调试器不支持请求：${request.command}`);
    }
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
    await Promise.all([runtime?.dispose(), this.processes.stop()]);
    this.temporary = undefined;
  }
  private finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.ended = true;
    this.phase = 'ended';
    this.finishing = this.cleanup().then(() => { this.event('terminated'); });
    return this.finishing;
  }
}
