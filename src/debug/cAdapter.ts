import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DebugAdapter, DebugProtocolMessage, Disposable, Event } from 'vscode';
import { build, Processes, Project } from '../core';
import { AdapterOptions, DebugDisplay } from './adapter';
import type { CapabilityLedger } from '../dependencies/capabilities';
import { GdbRuntime } from './gdbRuntime';
import { MiRecord, MiTuple, MiValue, miQuote } from './mi';
import { inspectDescriptors, inspectMemory } from './inspection';
import { inspectPaging } from './paging';
import { disassemble } from './disassembly';
import { MachineBreakpoints, machineAddress, memoryDataId, watchpoint } from './machineBreakpoints';
import { cpuMode, DataWatchpoint, instructionAddress, stackAddress, stackWidth, WatchAccess } from './runtime';

interface Request { seq: number; command: string; arguments?: Record<string, unknown> }
/** Narrow, replaceable transport boundary also used by protocol regression tests. */
export interface CSourceRuntime {
  readonly capabilities?: CapabilityLedger;
  on(event: string, listener: (...args: any[]) => void): unknown;
  launch(): Promise<void>;
  mi(command: string): Promise<MiRecord>;
  registers(): Promise<Record<string, number>>;
  readMemory(address: number, count: number): Promise<Buffer>;
  readPhysicalMemory(address: number, count: number): Promise<Buffer>;
  resume(step?: boolean): Promise<void>;
  pause(): Promise<void>;
  dispose(): Promise<void>;
}
export interface CAdapterOptions extends AdapterOptions {
  runtimeFactory?: (project: Project, log: (text: string) => void, extraArgs: string[]) => CSourceRuntime;
  buildProject?: typeof build;
}
interface SourceBinding { requested: number; id: number; number: string; address?: number; line: number; source?: string }
interface MachineBinding { number: string; address: number; point?: DataWatchpoint }
interface Frame { id: number; level: number; name: string; line: number; column: number; instructionPointerReference?: string; source?: { name: string; path: string } }
type Handle = { kind: 'locals' | 'arguments' | 'registers' | 'stack' | 'mode'; frame: number } | { kind: 'object'; frame: number; object: string; expression?: string };
interface Variable { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string; memoryReference?: string; indexedVariables?: number; namedVariables?: number; presentationHint: { attributes: string[] } }
const hex = (value: number, digits = 8) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
const tuple = (value: MiValue | undefined): MiTuple => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value: MiValue | undefined, fallback = ''): string => typeof value === 'string' ? value : fallback;
function records(value: MiValue | undefined, wrapper?: string): MiTuple[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => { const row = tuple(item); return wrapper && row[wrapper] ? [tuple(row[wrapper])] : Object.keys(row).length ? [row] : []; });
}
const readOnly = { attributes: ['readOnly'] };
const watchWarning = 'C / GDB 的写入断点在值改变后暂停；同值写入由 GDB 继续执行。读取与读写断点按访问暂停。';

/** A C expression grammar with no calls, assignment, increment, comma or casts.
 * GDB also disables function calls. The whitelist is independent of MI quoting. */
export function isSafeCExpression(expression: string): boolean {
  if (!expression || expression.length > 512 || /[\r\n\0]/.test(expression)) return false;
  const tokens: string[] = []; let offset = 0;
  while (offset < expression.length) {
    const match = /^\s*(->|<<|>>|<=|>=|==|!=|&&|\|\||[A-Za-z_$][A-Za-z0-9_$]*|0[xX][0-9a-fA-F]+|[0-9]+|[.()[\]+*/%&|^~!<>-])/.exec(expression.slice(offset));
    if (!match) return /^\s*$/.test(expression.slice(offset)) && parse();
    tokens.push(match[1]); offset += match[0].length;
    if (tokens.length > 128) return false;
  }
  return parse();
  function parse(): boolean {
    let cursor = 0, depth = 0;
    const identifier = (token: string | undefined) => !!token && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token);
    const binary = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '<', '>', '<=', '>=', '==', '!=', '&&', '||']);
    function atom(): boolean {
      if (++depth > 32) return false;
      if (['*', '&', '+', '-', '~', '!'].includes(tokens[cursor])) { cursor++; const valid = atom(); depth--; return valid; }
      if (tokens[cursor] === '(') { cursor++; if (!expr() || tokens[cursor++] !== ')') return false; }
      else if (identifier(tokens[cursor]) || /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(tokens[cursor] ?? '')) cursor++;
      else return false;
      while (['.', '->', '['].includes(tokens[cursor])) {
        const op = tokens[cursor++];
        if (op === '[') { if (!expr() || tokens[cursor++] !== ']') return false; }
        else if (!identifier(tokens[cursor++])) return false;
      }
      depth--; return true;
    }
    function expr(): boolean { if (!atom()) return false; while (binary.has(tokens[cursor])) { cursor++; if (!atom()) return false; } return true; }
    return expr() && cursor === tokens.length && !tokens.some((token, index) => (token === '+' || token === '-') && tokens[index + 1] === token);
  }
}

/** DWARF/source DAP implementation backed by a private GDB/MI connection. */
export class CSourceDebugAdapter implements DebugAdapter {
  private readonly events = new EventEmitter();
  readonly onDidSendMessage: Event<DebugProtocolMessage> = (listener, thisArgs?, disposables?) => {
    const fn = (message: DebugProtocolMessage) => listener.call(thisArgs, message);
    this.events.on('message', fn);
    const disposable: Disposable = { dispose: () => this.events.off('message', fn) };
    disposables?.push(disposable); return disposable;
  };
  private seq = 1;
  private queue: Promise<void> = Promise.resolve();
  private readonly processes = new Processes();
  private runtime?: CSourceRuntime;
  private project?: Project;
  private display?: DebugDisplay;
  private phase: 'idle' | 'preparing' | 'configuring' | 'booting' | 'stopped' | 'running' | 'ended' = 'idle';
  private epoch = 0;
  private disposed = false;
  private ended = false;
  private finishing?: Promise<void>;
  private launchArgs: Record<string, unknown> = {};
  private readonly machine = new MachineBreakpoints();
  private sources = new Map<string, SourceBinding[]>();
  private desiredSources = new Map<string, number[]>();
  private sourceIds = new Map<string, number>();
  private sourceSerial = 1000000;
  private instructions = new Map<number, MachineBinding>();
  private watches = new Map<string, MachineBinding>();
  private entry?: { number: string; address?: number };
  private stopOnEntry = true;
  private internalPause = false;
  private internalStop?: MiTuple;
  private handles = new Map<number, Handle>();
  private framesById = new Map<number, Frame>();
  private framesCache?: Frame[];
  private handleSerial = 10000;
  private variableObjects = new Set<string>();
  private variableCache = new Map<string, Variable[]>();
  private lastDataHit?: { address: number; access: WatchAccess; ids: number[]; pc: number };
  constructor(private readonly options: CAdapterOptions) {}

  handleMessage(message: DebugProtocolMessage): void {
    if (this.disposed || (message as { type?: string }).type !== 'request') return;
    const request = message as unknown as Request;
    this.queue = this.queue.then(async () => {
      try { await this.dispatch(request); }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // VS Code can finish automatic reads for an old selected frame after a
        // step. Report read errors in their view/console without notifications.
        const inline = ['stackTrace', 'scopes', 'variables', 'evaluate', 'qemuAsm.inspectMemory', 'qemuAsm.inspectDescriptors', 'qemuAsm.inspectPaging', 'qemuAsm.disassemble'].includes(request.command);
        this.send({ type: 'response', request_seq: request.seq, command: request.command, success: false, message: text, body: { error: { id: 1, format: text, showUser: !inline } } });
        if (['launch', 'restart', 'configurationDone'].includes(request.command)) await this.finish();
      }
    });
  }
  async dispose(): Promise<void> { this.disposed = true; await this.finish(); await this.processes.dispose(); }
  private send(message: Record<string, unknown>): void { this.events.emit('message', { ...message, seq: this.seq++ } as unknown as DebugProtocolMessage); }
  private event(event: string, body: Record<string, unknown> = {}): void { this.send({ type: 'event', event, body }); }
  private response(request: Request, body: unknown = {}): void { this.send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body }); }
  private output(text: string, category = 'console'): void { this.options.log?.(text); this.event('output', { output: text, category }); }
  private trust(): void { if (!this.options.isTrusted()) throw new Error('请先信任工作区，才能启动或控制调试器'); }
  private requireStopped(): CSourceRuntime { this.trust(); if (!this.runtime || this.phase !== 'stopped') throw new Error('请先暂停程序，再查看 C 变量、寄存器或内存'); return this.runtime; }
  private breakpointRuntime(): CSourceRuntime { this.trust(); if (!this.runtime || !['stopped', 'configuring'].includes(this.phase)) throw new Error('请先暂停程序，再修改断点'); return this.runtime; }
  private async prepare(args: Record<string, unknown>): Promise<void> {
    this.trust(); if (this.disposed) throw new Error('调试适配器已释放');
    this.launchArgs = args; this.stopOnEntry = args.stopOnEntry !== false; this.ended = false; this.phase = 'preparing';
    const epoch = ++this.epoch;
    const project = this.project = await this.options.getProject();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    if (!project.debug) throw new Error('C 源码调试需要在项目中配置 debug.elf');
    this.trust();
    await (this.options.buildProject ?? build)(project, this.processes, text => this.output(text, 'stderr'), () => epoch !== this.epoch);
    await fs.access(project.debug.elf);
    this.trust(); if (epoch !== this.epoch) throw new Error('调试启动已取消');
    const display = this.display = await this.options.createDisplay?.();
    if (epoch !== this.epoch) { await display?.dispose(); throw new Error('调试启动已取消'); }
    this.trust();
    const runtime = this.runtime = this.options.runtimeFactory?.(project, text => this.output(text, 'stdout'), display?.args ?? []) ?? new GdbRuntime(project, text => this.output(text, 'stdout'), display?.args);
    if (runtime.capabilities) display?.observeCapabilities?.(runtime.capabilities);
    runtime.on('stopped', (event: MiTuple) => {
      if (epoch !== this.epoch || this.phase === 'preparing' || this.phase === 'ended') return;
      if (this.internalPause) { this.internalStop = event; return; }
      this.phase = 'stopped';
      this.queue = this.queue.then(async () => { if (epoch === this.epoch) await this.onStopped(event); }).catch(async error => { this.output(`${String(error)}\n`, 'stderr'); await this.finish(); });
    });
    runtime.on('terminated', (result: { error?: string }) => { if (epoch !== this.epoch) return; if (result.error) this.output(`${result.error}\n`, 'stderr'); void this.finish(); });
    await runtime.launch();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.phase = 'configuring';
    for (const [file, lines] of this.desiredSources) await this.replaceSource(file, lines);
    await this.replaceInstructions(this.machine.instructionAddresses());
    await this.replaceWatches(this.machine.dataPoints());
    await display?.connect();
    if (epoch !== this.epoch) throw new Error('调试启动已取消');
    this.output('C 源码调试已就绪：ELF/DWARF、源码单步、调用栈、只读变量，以及机器级调试观察器。\n');
  }
  private async boot(): Promise<void> {
    const runtime = this.breakpointRuntime(), project = this.project!;
    let location = project.debug?.entry;
    if (location && /^(?:0x[0-9a-f]+|\d+)$/i.test(location)) location = `*${hex(machineAddress(location))}`;
    if (!location) {
      const file = await fs.open(project.debug!.elf, 'r'), bytes = Buffer.alloc(52);
      try { const result = await file.read(bytes, 0, bytes.length, 0); if (result.bytesRead !== bytes.length) throw new Error('ELF 文件头不完整'); }
      finally { await file.close(); }
      if (bytes.length < 52 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 1 || bytes[5] !== 1) throw new Error('需要 32 位小端 ELF，或配置明确的 debug.entry');
      location = `*${hex(bytes.readUInt32LE(24))}`;
    }
    const result = tuple((await runtime.mi(`-break-insert -h ${miQuote(location)}`)).results.bkpt);
    if (!string(result.number)) throw new Error('无法为 ELF 入口设置硬件断点');
    this.entry = { number: string(result.number), ...(this.parseAddress(result.addr) === undefined ? {} : { address: this.parseAddress(result.addr) }) };
    this.phase = 'booting'; await runtime.resume(); this.event('continued', { threadId: 1, allThreadsContinued: true });
  }
  private async onStopped(event: MiTuple): Promise<void> {
    if (!this.runtime || this.phase === 'ended') return;
    const rawReason = string(event.reason);
    if (/^exited/.test(rawReason)) { await this.finish(); return; }
    await this.expireVariables(); this.phase = 'stopped';
    const number = string(event.bkptno) || string(tuple(event.wpt).number) || string(tuple(event['hw-rwpt']).number) || string(tuple(event['hw-awpt']).number);
    // Validate CPU mode at every stop, including source-only sessions. GDB's
    // frame address is source context; cached CS.base determines the live PC.
    const registers = await this.runtime.registers(), frame = tuple(event.frame), pc = instructionAddress(registers);
    const hitEntry = !!this.entry && (number === this.entry.number || pc === this.entry.address);
    if (hitEntry) { await this.deleteBindings(this.runtime, [this.entry!.number]); this.entry = undefined; }
    const watch = [...this.watches.values()].find(binding => binding.number === number);
    const data = !!watch?.point || /watchpoint-trigger/.test(rawReason);
    const sourceIds = [...this.sources.values()].flat().filter(binding => binding.number === number || binding.address === pc).map(binding => binding.id);
    const ids = data && watch?.point ? this.machine.dataHits(watch.point.address, watch.point.access) : rawReason === 'breakpoint-hit' ? [...sourceIds, ...this.machine.instructionHit(pc)] : [];
    if (watch?.point) this.lastDataHit = { address: watch.point.address, access: watch.point.access, ids, pc };
    if (hitEntry && !this.stopOnEntry && !ids.length && !data) { await this.motion('-exec-continue'); return; }
    const reason = data ? 'data breakpoint' : hitEntry && !ids.length ? 'entry' : rawReason === 'breakpoint-hit' ? 'breakpoint' : rawReason === 'signal-received' ? string(event['signal-name']) === 'SIGINT' ? 'pause' : 'exception' : 'step';
    this.output(`[暂停 ${reason}] ${hex(pc)}${string(frame.func) ? ` ${string(frame.func)}` : ''}${string(frame.line) ? ` 第 ${string(frame.line)} 行` : ''}\n`);
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, description: data && watch?.point ? `数据断点 ${hex(watch.point.address)}（${watch.point.access}），访问已完成` : string(event['signal-meaning']) || string(frame.func) || hex(pc), ...(ids.length ? { hitBreakpointIds: [...new Set(ids)] } : {}) });
    this.event('invalidated', { areas: ['stacks', 'variables'] });
  }
  private async motion(command: string): Promise<void> {
    const runtime = this.requireStopped();
    await this.expireVariables();
    this.phase = 'running';
    try { await runtime.mi(command); } catch (error) { if (this.phase === 'running') this.phase = 'stopped'; throw error; }
    this.event('continued', { threadId: 1, allThreadsContinued: true });
  }
  private parseAddress(value: MiValue | undefined): number | undefined { const text = string(value); const match = /^(0x[\da-f]+)(?:\s|$)/i.exec(text); if (!match) return undefined; const address = Number(match[1]); return Number.isSafeInteger(address) && address >= 0 && address <= 0xffffffff ? address : undefined; }
  private async fileKey(file: string): Promise<string> { let canonical = path.resolve(file); try { canonical = await fs.realpath(canonical); } catch {} return process.platform === 'win32' ? canonical.toLowerCase() : canonical; }
  private sourceId(file: string, line: number): number { const key = `${file}:${line}`; let id = this.sourceIds.get(key); if (!id) { id = this.sourceSerial++; this.sourceIds.set(key, id); } return id; }
  private async replaceSource(file: string, lines: number[]): Promise<Map<number, Record<string, unknown>>> {
    const runtime = this.breakpointRuntime(), previous = this.sources.get(file) ?? [], next: SourceBinding[] = [], results = new Map<number, Record<string, unknown>>();
    try {
      for (const line of [...new Set(lines)]) {
        const retained = previous.find(item => item.requested === line);
        if (retained) { next.push(retained); results.set(line, this.sourceResult(retained)); continue; }
        try {
          // MI quoting alone does not quote GDB's separate linespec grammar:
          // commas in a valid filename are linespec delimiters. Explicit source
          // and line options pass the filename as data through both parsers.
          const record = tuple((await runtime.mi(`-break-insert -h --source ${miQuote(file)} --line ${line}`)).results.bkpt), number = string(record.number);
          if (!number || this.parseAddress(record.addr) === undefined || string(record.pending)) { if (number) await this.deleteBindings(runtime, [number]); throw new Error('GDB 未找到此行的可执行代码'); }
          const binding: SourceBinding = { requested: line, id: this.sourceId(file, line), number, address: this.parseAddress(record.addr), line: integer(Number(string(record.line)), line), source: string(record.fullname) || file };
          next.push(binding); results.set(line, this.sourceResult(binding));
        } catch (error) { if (this.runtime !== runtime) throw error; results.set(line, { verified: false, line, message: error instanceof Error ? error.message : String(error) }); }
      }
      const removed = previous.filter(item => !next.includes(item));
      await this.deleteBindings(runtime, removed.map(item => item.number));
      this.sources.set(file, next); return results;
    } catch (error) { await this.removeAdded(runtime, next.filter(item => !previous.includes(item)).map(item => item.number)); throw error; }
  }
  private sourceResult(binding: SourceBinding): Record<string, unknown> { return { id: binding.id, verified: true, line: binding.line, ...(binding.source ? { source: { path: binding.source, name: path.basename(binding.source) } } : {}), ...(binding.address === undefined ? {} : { instructionReference: hex(binding.address) }) }; }
  private async deleteBindings(runtime: CSourceRuntime, numbers: string[]): Promise<void> {
    if (!numbers.length) return;
    try { await runtime.mi(`-break-delete ${numbers.join(' ')}`); }
    catch (error) {
      // GDB may have applied part of a multi-delete before rejecting it. A
      // failed replacement must never leave a live, incorrectly tracked target.
      await this.finish();
      throw new Error(`删除断点失败，调试会话已关闭：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async removeAdded(runtime: CSourceRuntime, numbers: string[]): Promise<void> { if (!numbers.length) return; try { await runtime.mi(`-break-delete ${numbers.join(' ')}`); } catch { await this.finish(); } }
  private async replaceInstructions(addresses: number[]): Promise<void> {
    const runtime = this.breakpointRuntime(), previous = this.instructions, next = new Map<number, MachineBinding>(), added: string[] = [];
    try {
      for (const address of addresses) {
        const retained = previous.get(address); if (retained) { next.set(address, retained); continue; }
        const result = tuple((await runtime.mi(`-break-insert -h ${miQuote(`*${hex(address)}`)}`)).results.bkpt), number = string(result.number);
        if (!number) throw new Error('GDB 未确认指令断点');
        added.push(number); next.set(address, { number, address });
      }
      const removed = [...previous].filter(([address]) => !next.has(address)).map(([, item]) => item.number);
      await this.deleteBindings(runtime, removed);
      this.instructions = next;
    } catch (error) { await this.removeAdded(runtime, added); throw error; }
  }
  private async replaceWatches(points: DataWatchpoint[]): Promise<void> {
    const runtime = this.breakpointRuntime(), previous = this.watches, next = new Map<string, MachineBinding>(), added: string[] = [];
    try {
      for (const point of points) {
        const key = `${point.address}:${point.size}:${point.access}`, retained = previous.get(key);
        if (retained) { next.set(key, retained); continue; }
        const type = point.size === 1 ? 'unsigned char' : point.size === 2 ? 'unsigned short' : 'unsigned int';
        const option = point.access === 'read' ? '-r ' : point.access === 'readWrite' ? '-a ' : '';
        const result = (await runtime.mi(`-break-watch ${option}${miQuote(`*(${type} *)${hex(point.address)}`)}`)).results;
        const record = tuple(result.wpt ?? result['hw-rwpt'] ?? result['hw-awpt']), number = string(record.number);
        if (!number) throw new Error('GDB 未确认数据断点');
        added.push(number); next.set(key, { number, address: point.address, point });
      }
      const removed = [...previous].filter(([key]) => !next.has(key)).map(([, item]) => item.number);
      await this.deleteBindings(runtime, removed);
      this.watches = next;
    } catch (error) { await this.removeAdded(runtime, added); throw error; }
  }
  private handle(value: Handle): number { if (this.handles.size >= 4096) throw new Error('当前暂停最多展开 4096 个变量节点，请继续后重试'); const id = this.handleSerial++; this.handles.set(id, value); return id; }
  private async frames(): Promise<Frame[]> {
    if (this.framesCache) return this.framesCache;
    const runtime = this.requireStopped(), rows = records((await runtime.mi('-stack-list-frames --thread 1 0 63')).results.stack, 'frame');
    const frames = rows.map(row => {
      const dwarfLine = Number(string(row.line)), address = this.parseAddress(row.addr);
      const sourcePath = Number.isSafeInteger(dwarfLine) && dwarfLine > 0 ? string(row.fullname) || (string(row.file) ? path.resolve(this.project!.root, string(row.file)) : undefined) : undefined;
      const frame: Frame = { id: this.handleSerial++, level: Number(string(row.level, '0')), name: string(row.func, '未知函数'), line: sourcePath ? dwarfLine : 1, column: 1, ...(address === undefined ? {} : { instructionPointerReference: hex(address) }), ...(sourcePath ? { source: { name: path.basename(sourcePath), path: sourcePath } } : {}) };
      this.framesById.set(frame.id, frame); return frame;
    });
    return this.framesCache = frames;
  }
  private frame(id: unknown): Frame {
    const frame = typeof id === 'number' ? this.framesById.get(id) : this.framesCache?.[0];
    if (!frame) throw new Error('调用栈帧已过期，请在当前暂停后重新选择'); return frame;
  }
  private async expireVariables(): Promise<void> {
    const objects = [...this.variableObjects]; this.variableObjects.clear(); this.handles.clear(); this.framesById.clear(); this.framesCache = undefined; this.variableCache.clear();
    if (!this.runtime) return;
    for (const object of objects) { try { await this.runtime.mi(`-var-delete ${miQuote(object)}`); } catch { /* Varobjs can disappear with their frame; never reuse their handles. */ } }
  }
  private variable(record: MiTuple, frame: number, expression?: string, root = false): Variable {
    const object = string(record.name), count = Number(string(record.numchild, '0'));
    // Deleting a root varobj recursively deletes all children. Tracking child
    // names separately would turn one expanded array into hundreds of failing
    // -var-delete requests on every source step.
    if (object && root) this.variableObjects.add(object);
    const value = string(record.value, '<不可用>'), type = string(record.type);
    return { name: string(record.exp) || expression || object, value, ...(type ? { type } : {}), variablesReference: count > 0 || string(record.has_more) === '1' ? this.handle({ kind: 'object', frame, object, expression }) : 0, ...(count > 0 ? /\[[^\]]*\]$/.test(type) && !type.includes('*') ? { indexedVariables: count } : { namedVariables: count } : {}), ...(expression ? { evaluateName: expression } : {}), ...(type.includes('*') && this.parseAddress(value) !== undefined ? { memoryReference: hex(this.parseAddress(value)!) } : {}), presentationHint: readOnly };
  }
  private async createVariable(expression: string, frame: number): Promise<Variable> {
    if (this.variableObjects.size >= 512) throw new Error('当前暂停最多展开 512 个变量对象，请继续后重试');
    const record = (await this.requireStopped().mi(`-var-create --thread 1 --frame ${frame} - * ${miQuote(expression)}`)).results;
    return this.variable(record, frame, expression, true);
  }
  private async variables(reference: number, start: number, count: number): Promise<Variable[]> {
    const runtime = this.requireStopped(), handle = this.handles.get(reference);
    if (!handle) return [];
    if (handle.kind === 'locals' || handle.kind === 'arguments') {
      const key = `${handle.kind}:${handle.frame}`; let variables = this.variableCache.get(key);
      if (!variables) {
        const rows = records((await runtime.mi(`-stack-list-variables --thread 1 --frame ${handle.frame} --simple-values`)).results.variables);
        variables = [];
        for (const row of rows.filter(row => (string(row.arg) === '1') === (handle.kind === 'arguments')).slice(0, 256)) {
          const name = string(row.name);
          try { variables.push({ ...await this.createVariable(name, handle.frame), name }); }
          catch (error) { variables.push({ name, value: string(row.value) || `<${error instanceof Error ? error.message : String(error)}>`, type: string(row.type), variablesReference: 0, evaluateName: name, presentationHint: readOnly }); }
        }
        this.variableCache.set(key, variables);
      }
      return variables.slice(start, start + count);
    }
    if (handle.kind === 'object') {
      const key = `object:${handle.object}:${start}:${count}`, cached = this.variableCache.get(key);
      if (cached) return cached;
      const rows = records((await runtime.mi(`-var-list-children --all-values ${miQuote(handle.object)} ${start} ${start + count}`)).results.children, 'child'), variables: Variable[] = [];
      for (const row of rows) {
        let expression: string | undefined;
        try { expression = string((await runtime.mi(`-var-info-path-expression ${miQuote(string(row.name))}`)).results.path_expr) || undefined; } catch {}
        variables.push(this.variable(row, handle.frame, expression));
      }
      this.variableCache.set(key, variables); return variables;
    }
    const r = await runtime.registers();
    if (handle.kind === 'registers') return Object.entries(r).slice(start, start + count).map(([name, value]) => ({ name: name.toUpperCase(), value: hex(value), type: '寄存器（当前 CPU）', variablesReference: 0, evaluateName: `$${name}`, presentationHint: readOnly }));
    if (handle.kind === 'mode') return Object.entries({ MODE: cpuMode(r), '栈指针位数': String(stackWidth(r) * 8), '指令线性地址': hex(instructionAddress(r)), '栈线性地址': hex(stackAddress(r)), 'CR0.PG': String((r.cr0 ?? 0) >>> 31), CR3: hex(r.cr3 ?? 0) }).slice(start, start + count).map(([name, value]) => ({ name, value, variablesReference: 0, presentationHint: readOnly }));
    const width = cpuMode(r) === 'protected32' ? 4 : 2, pointer = stackWidth(r), sp = pointer === 4 ? r.esp >>> 0 : r.esp & 0xffff, maximum = pointer === 4 ? 0xffffffff : 0xffff;
    const expandDown = cpuMode(r) !== 'real16' && !!((r.ss_flags ?? 0) & (1 << 10)), lower = expandDown ? (r.ss_limit ?? maximum) + 1 : 0, upper = expandDown ? maximum : Math.min(maximum, r.ss_limit ?? maximum);
    const address = stackAddress(r), bytes = sp >= lower && sp <= upper ? await runtime.readMemory(address, Math.min(16 * width, upper - sp + 1, 0x100000000 - address)) : Buffer.alloc(0), result: Variable[] = [];
    for (let offset = 0; offset + width <= bytes.length; offset += width) result.push({ name: `${hex(r.ss, 4)}:${hex(sp + offset, pointer * 2)}${offset === 0 ? ' ← ESP' : ''}`, value: hex(width === 4 ? bytes.readUInt32LE(offset) : bytes.readUInt16LE(offset), width * 2), type: `uint${width * 8}`, variablesReference: 0, memoryReference: hex(address + offset), presentationHint: readOnly });
    return result.slice(start, start + count);
  }

  private async dispatch(request: Request): Promise<void> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'initialize': this.response(request, { supportsConfigurationDoneRequest: true, supportsReadMemoryRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true, supportsRestartRequest: true, supportsSetVariable: false, supportsDisassembleRequest: true, supportsInstructionBreakpoints: true, supportsDataBreakpoints: true, supportsSteppingGranularity: true, supportsVariablePaging: true }); return;
      case 'launch': await this.prepare(args); this.response(request); this.event('initialized'); return;
      case 'configurationDone': await this.boot(); this.response(request); return;
      case 'qemuAsm.dependencyReport':
        this.trust();
        if (!this.runtime?.capabilities) throw new Error('调试运行时尚未提供依赖报告');
        this.response(request, this.runtime.capabilities.snapshot()); return;
      case 'threads': this.response(request, { threads: this.phase === 'ended' ? [] : [{ id: 1, name: 'CPU 0（C / ELF / DWARF）' }] }); return;
      case 'setBreakpoints': {
        this.trust(); const file = typeof (args.source as { path?: unknown } | undefined)?.path === 'string' ? await this.fileKey((args.source as { path: string }).path) : '';
        if (!file) throw new Error('源码断点需要 source.path');
        const inputs = Array.isArray(args.breakpoints) ? args.breakpoints as Record<string, unknown>[] : [];
        if (inputs.length > 256) throw new Error('每个源文件最多设置 256 个断点');
        const lines = inputs.filter(item => Number.isInteger(item.line) && Number(item.line) > 0 && !item.condition && !item.hitCondition && !item.logMessage).map(item => Number(item.line));
        const wasRunning = ['running', 'booting'].includes(this.phase), previous = this.phase;
        if (wasRunning) { this.internalPause = true; this.internalStop = undefined; try { await this.runtime!.pause(); } finally { this.internalPause = false; } this.phase = 'stopped'; }
        let results: Map<number, Record<string, unknown>>;
        try { results = await this.replaceSource(file, lines); }
        catch (error) {
          if (wasRunning && this.runtime && this.phase !== 'ended') {
            if (!this.options.isTrusted()) await this.finish();
            else await this.onStopped(this.internalStop ?? { reason: 'signal-received', 'signal-name': 'SIGINT' });
          }
          this.internalStop = undefined; throw error;
        }
        this.desiredSources.set(file, lines);
        this.response(request, { breakpoints: inputs.map(item => item.condition || item.hitCondition || item.logMessage ? { verified: false, line: item.line, message: '暂不支持条件、命中次数或日志断点' } : results.get(Number(item.line)) ?? { verified: false, line: item.line, message: '行号必须为正整数' }) });
        if (wasRunning) {
          const stop = this.internalStop; this.internalStop = undefined;
          if (stop && !(string(stop.reason) === 'signal-received' && string(stop['signal-name']) === 'SIGINT')) await this.onStopped(stop);
          else { await this.motion('-exec-continue'); if (previous === 'booting' && this.phase === 'running') this.phase = 'booting'; }
        }
        return;
      }
      case 'stackTrace': {
        this.trust(); if (this.phase !== 'stopped') { this.response(request, { stackFrames: [], totalFrames: 0 }); return; }
        const frames = await this.frames(), start = Math.max(0, integer(args.startFrame, 0)), levels = Math.max(1, Math.min(64, integer(args.levels, 64) || 64));
        this.response(request, { stackFrames: frames.slice(start, start + levels), totalFrames: frames.length }); return;
      }
      case 'scopes': {
        this.trust(); if (this.phase !== 'stopped') { this.response(request, { scopes: [] }); return; }
        const frame = typeof args.frameId === 'number' ? this.framesById.get(args.frameId) : this.framesCache?.[0];
        // Expired frame IDs belong to a previous stop. Never resolve them to
        // the new current frame or create handles for delayed native UI reads.
        if (!frame) { this.response(request, { scopes: [] }); return; }
        const scopes = [{ name: '局部变量', variablesReference: this.handle({ kind: 'locals', frame: frame.level }), expensive: false }, { name: '参数', variablesReference: this.handle({ kind: 'arguments', frame: frame.level }), expensive: false }];
        if (frame.level === 0) scopes.push({ name: '寄存器（当前 CPU）', variablesReference: this.handle({ kind: 'registers', frame: 0 }), expensive: false }, { name: '栈内存 SS:SP / SS:ESP', variablesReference: this.handle({ kind: 'stack', frame: 0 }), expensive: false }, { name: 'CPU 模式与地址', variablesReference: this.handle({ kind: 'mode', frame: 0 }), expensive: false });
        this.response(request, { scopes }); return;
      }
      case 'variables': this.trust(); this.response(request, { variables: this.phase === 'stopped' ? await this.variables(integer(args.variablesReference, 0), Math.max(0, integer(args.start, 0)), Math.max(1, Math.min(256, integer(args.count, 256) || 256))) : [] }); return;
      case 'continue': await this.motion('-exec-continue'); this.response(request, { allThreadsContinued: true }); return;
      case 'stepIn': await this.motion(args.granularity === 'instruction' ? '-exec-step-instruction' : '-exec-step'); this.response(request); return;
      case 'next': await this.motion(args.granularity === 'instruction' ? '-exec-next-instruction' : '-exec-next'); this.response(request); return;
      case 'stepOut': await this.motion('-exec-finish'); this.response(request); return;
      case 'pause': this.trust(); if (this.runtime && ['running', 'booting'].includes(this.phase)) await this.runtime.pause(); this.response(request); return;
      case 'disassemble': this.response(request, { instructions: (await disassemble(this.requireStopped(), args)).instructions }); return;
      case 'qemuAsm.disassemble': this.response(request, { ...await disassemble(this.requireStopped(), args), breakpoints: this.machine.instructions().breakpoints }); return;
      case 'setInstructionBreakpoints': this.breakpointRuntime(); this.response(request, { breakpoints: await this.machine.setNativeInstructions(args.breakpoints ?? [], addresses => this.replaceInstructions(addresses)) }); return;
      case 'qemuAsm.instructionBreakpoints': this.requireStopped(); this.response(request, await this.machine.changeInstruction(args, addresses => this.replaceInstructions(addresses))); return;
      case 'setDataBreakpoints': {
        this.breakpointRuntime(); const inputs = Array.isArray(args.breakpoints) ? args.breakpoints as Record<string, unknown>[] : [];
        const breakpoints = await this.machine.setNativeWatches(args.breakpoints ?? [], points => this.replaceWatches(points));
        this.response(request, { breakpoints: breakpoints.map((point, index) => point.verified && (inputs[index]?.accessType ?? 'write') === 'write' ? { ...point, message: watchWarning } : point) }); return;
      }
      case 'qemuAsm.watchpoints': this.requireStopped(); this.response(request, { ...await this.machine.changeWatch(args, points => this.replaceWatches(points)), warnings: [watchWarning], ...(this.lastDataHit ? { lastHit: this.lastDataHit } : {}) }); return;
      case 'dataBreakpointInfo': await this.dataBreakpointInfo(request, args); return;
      case 'qemuAsm.inspectMemory': this.response(request, await inspectMemory(this.requireStopped(), args)); return;
      case 'qemuAsm.inspectDescriptors': this.response(request, await inspectDescriptors(this.requireStopped(), args)); return;
      case 'qemuAsm.inspectPaging': this.response(request, await inspectPaging(this.requireStopped(), args)); return;
      case 'readMemory': {
        const address = machineAddress(machineAddress(args.memoryReference) + integer(args.offset, 0)), count = integer(args.count, 0);
        if (count < 0 || count > 4096) throw new Error('每次最多读取 4096 字节');
        this.response(request, { address: hex(address), data: (await this.requireStopped().readMemory(address, count)).toString('base64') }); return;
      }
      case 'evaluate': {
        this.trust(); if (this.phase !== 'stopped') { this.response(request, { result: 'CPU 未暂停；暂停后更新', variablesReference: 0 }); return; }
        const expression = String(args.expression ?? '').trim();
        if (!isSafeCExpression(expression)) throw new Error('仅支持只读 C 表达式：变量、成员、指针、下标和算术；不允许赋值、递增或函数调用');
        // Validate an explicit frame before reading GDB: an expired frame must
        // not silently select the current frame or create a new varobj.
        if (typeof args.frameId !== 'number') await this.frames();
        const frame = this.frame(args.frameId), value = await this.createVariable(expression, frame.level);
        this.response(request, { result: value.value, type: value.type, variablesReference: value.variablesReference, ...(value.memoryReference ? { memoryReference: value.memoryReference } : {}), ...(value.indexedVariables === undefined ? {} : { indexedVariables: value.indexedVariables }), ...(value.namedVariables === undefined ? {} : { namedVariables: value.namedVariables }) }); return;
      }
      case 'restart': if (this.ended) throw new Error('调试会话已结束，请重新启动调试'); await this.cleanup(); await this.prepare(this.launchArgs); await this.boot(); this.response(request); return;
      case 'disconnect': case 'terminate': this.response(request); await this.finish(); return;
      case 'setExceptionBreakpoints': this.response(request, { breakpoints: [] }); return;
      default: throw new Error(`当前 C 调试器不支持请求：${request.command}`);
    }
  }
  private async dataBreakpointInfo(request: Request, args: Record<string, unknown>): Promise<void> {
    const runtime = this.requireStopped();
    try {
      let address: number, size: number;
      if (args.memoryReference !== undefined) { address = machineAddress(args.memoryReference); size = args.bytes === undefined ? 1 : Number(args.bytes); }
      else if (typeof args.variablesReference === 'number' && this.handles.has(args.variablesReference) && typeof args.name === 'string') {
        const handle = this.handles.get(args.variablesReference)!;
        let expression = args.name;
        if (handle.kind === 'object') {
          const rows = await this.variables(args.variablesReference, 0, 256), child = rows.find(row => row.name === args.name);
          if (!child?.evaluateName) throw new Error('无法获取该变量的 C 地址表达式'); expression = child.evaluateName;
        } else if (handle.kind !== 'locals' && handle.kind !== 'arguments') throw new Error('请选择 C 变量或明确的内存地址');
        if (!isSafeCExpression(expression)) throw new Error('变量地址表达式不受支持');
        const context = `--thread 1 --frame ${handle.frame}`;
        address = this.parseAddress((await runtime.mi(`-data-evaluate-expression ${context} ${miQuote(`&(${expression})`)}`)).results.value)!;
        if (address === undefined) throw new Error('变量没有可读取的内存地址（可能被优化或位于寄存器）');
        size = Number(string((await runtime.mi(`-data-evaluate-expression ${context} ${miQuote(`sizeof(${expression})`)}`)).results.value));
      } else { address = machineAddress(args.name); size = args.bytes === undefined ? 1 : Number(args.bytes); }
      const point = watchpoint({ address, size, access: 'write' });
      this.response(request, { dataId: memoryDataId(point.address, point.size), description: `${hex(point.address)} · ${point.size} 字节`, accessTypes: ['read', 'write', 'readWrite'], canPersist: args.variablesReference === undefined });
    } catch (error) { this.response(request, { dataId: null, description: error instanceof Error ? error.message : String(error) }); }
  }
  private async cleanup(): Promise<void> {
    ++this.epoch; const runtime = this.runtime; this.runtime = undefined; const display = this.display; this.display = undefined;
    this.handles.clear(); this.framesById.clear(); this.framesCache = undefined; this.variableCache.clear(); this.variableObjects.clear();
    this.sources.clear(); this.instructions.clear(); this.watches.clear(); this.entry = undefined; this.lastDataHit = undefined;
    await Promise.all([runtime?.dispose(), display?.dispose(), this.processes.stop()]);
  }
  private finish(): Promise<void> { if (this.finishing) return this.finishing; this.ended = true; this.phase = 'ended'; return this.finishing = this.cleanup().then(() => { this.event('terminated'); }); }
}
