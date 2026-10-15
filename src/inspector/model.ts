/** Guest snapshots and breakpoint changes only operate at confirmed stops; memory is never persisted. */
export type InspectorTab = 'memory' | 'gdt' | 'idt' | 'disassembly' | 'watchpoints' | 'paging';
export type MemoryFollow = 'address' | 'esp' | 'ebp';
export interface InspectorSession { readonly id: string; customRequest(command: string, args: unknown): Thenable<unknown>; }
export type MemorySpace = 'virtual' | 'physical';
export interface InspectorForm { tab: InspectorTab; address: number; follow: MemoryFollow; memorySpace: MemorySpace; pagingAddress: number; gdtStart: number; idtStart: number; disassemblyAddress: number; disassemblyFollow: boolean; }
export interface MemoryData { address: number; count: number; bytes: number[]; mode: string; follow: MemoryFollow; space: MemorySpace; addressContext: string; pagingEnabled: boolean; cr3?: number; cr4?: number; pageMappings: { virtualPage: number; physicalPage: number }[]; changed: boolean[]; }
export interface DescriptorEntry {
  index: number; address: number; raw: string; kind: string; type: string; present: boolean; dpl: number; valid: boolean;
  warnings: string[]; selector?: number; targetSelector?: number; parameterCount?: number; base?: number; effectiveLimit?: number; granularity?: boolean;
  defaultBits?: number; registers?: string[]; cacheWarnings?: string[]; offset?: number; gateBits?: number;
  readable?: boolean; writable?: boolean; conforming?: boolean; expandDown?: boolean; accessed?: boolean;
}
export interface DescriptorData { table: 'gdt' | 'idt'; format: string; mode: string; base: number; limit: number; entrySize: number; totalEntries: number; start: number; count: number; entries: DescriptorEntry[]; warnings: string[]; }
export interface DisassemblyInstruction { address: string; instructionBytes: string; instruction: string; size: number; presentationHint?: 'normal' | 'invalid'; }
export interface DisassemblyData { address: number; pc: number; mode: string; bits: 16 | 32; instructions: DisassemblyInstruction[]; nextAddress: number; }
export type BreakpointOrigin = 'native' | 'custom' | 'both';
export interface InstructionBreakpoint { address: number; verified: boolean; id?: number; message?: string; origin: BreakpointOrigin; }
export type WatchAccess = 'write' | 'read' | 'readWrite';
export interface Watchpoint { id: number; dataId: string; address: number; size: 1 | 2 | 4; access: WatchAccess; verified: boolean; message?: string; origin: BreakpointOrigin; }
export interface WatchpointData { breakpoints: Watchpoint[]; warnings?: string[]; lastHit?: { address: number; access: WatchAccess; ids: number[]; pc: number }; }
export interface PageEntry {
  level: 'directory' | 'table'; index: number; address: number; raw: number; present: boolean; writable: boolean; user: boolean;
  writeThrough: boolean; cacheDisable: boolean; accessed: boolean; dirty?: boolean; pageSize?: boolean; global?: boolean; pat?: boolean;
  base?: number; reservedBits?: number;
}
export interface PagingData {
  address: number; mode: string; pagingEnabled: boolean; format: 'disabled' | 'legacy32'; cr0: number; cr3?: number; cr4?: number;
  wp: boolean; pse: boolean; directoryBase?: number; directoryIndex: number; tableIndex: number; offset: number;
  status: 'identity' | 'mapped' | 'not-present' | 'invalid' | 'unsupported'; physicalAddress?: number; pageSize?: 4096 | 4194304;
  faultLevel?: 'directory' | 'table'; pde?: PageEntry; pte?: PageEntry;
  effective?: { user: boolean; writable: boolean; supervisorRead: boolean; supervisorWrite: boolean; userRead: boolean; userWrite: boolean };
  warnings: string[]; explanation: string;
}
export interface InspectorSnapshot {
  generation: number; sessionId?: string; form: InspectorForm; status: 'idle' | 'running' | 'stopped'; busy: boolean; stale: boolean; message: string;
  memory?: MemoryData; gdt?: DescriptorData; idt?: DescriptorData; disassembly?: DisassemblyData; instructionBreakpoints?: InstructionBreakpoint[]; watchpoints?: WatchpointData; paging?: PagingData;
}
const motion = new Set(['continue', 'next', 'stepIn', 'stepOut', 'reverseContinue', 'stepBack']);
export function parseAddress(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 32 || !/^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}
function validForm(value: Partial<InspectorForm>): Partial<InspectorForm> {
  const result: Partial<InspectorForm> = {};
  if (['memory', 'gdt', 'idt', 'disassembly', 'watchpoints', 'paging'].includes(value.tab!)) result.tab = value.tab;
  if (value.memorySpace === 'virtual' || value.memorySpace === 'physical') result.memorySpace = value.memorySpace;
  if (value.follow === 'address' || value.follow === 'esp' || value.follow === 'ebp') result.follow = value.follow;
  for (const key of ['address', 'disassemblyAddress', 'pagingAddress', 'gdtStart', 'idtStart'] as const) {
    const max = key === 'address' || key === 'disassemblyAddress' || key === 'pagingAddress' ? 0xffffffff : 8191;
    if (Number.isInteger(value[key]) && value[key]! >= 0 && value[key]! <= max) result[key] = value[key];
  }
  if (typeof value.disassemblyFollow === 'boolean') result.disassemblyFollow = value.disassemblyFollow;
  return result;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function memoryData(value: unknown): value is Omit<MemoryData, 'changed'> {
  return object(value) && Number.isInteger(value.address) && (value.address as number) >= 0 && (value.address as number) <= 0xffffffff
    && Array.isArray(value.bytes) && value.bytes.length <= 256 && value.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && value.count === value.bytes.length && (value.address as number) + value.bytes.length <= 0x100000000
    && typeof value.mode === 'string' && ['address', 'esp', 'ebp'].includes(value.follow as string)
    && (value.space === 'virtual' || value.space === 'physical') && typeof value.addressContext === 'string' && value.addressContext.length <= 128
    && Array.isArray(value.pageMappings) && value.pageMappings.length <= 2 && value.pageMappings.every(mapping => object(mapping) && uint32(mapping.virtualPage) && uint32(mapping.physicalPage) && mapping.virtualPage % 4096 === 0 && mapping.physicalPage % 4096 === 0)
    && typeof value.pagingEnabled === 'boolean' && (value.cr3 === undefined || uint32(value.cr3)) && (value.cr4 === undefined || uint32(value.cr4));
}
function descriptorData(value: unknown, table: 'gdt' | 'idt'): value is DescriptorData {
  return object(value) && value.table === table && typeof value.format === 'string' && typeof value.mode === 'string'
    && Number.isInteger(value.base) && Number.isInteger(value.limit) && Number.isInteger(value.totalEntries)
    && Number.isInteger(value.start) && Number.isInteger(value.count) && Array.isArray(value.entries)
    && value.entries.length <= 64 && value.entries.every(entry => object(entry) && Number.isInteger(entry.index)
      && typeof entry.raw === 'string' && typeof entry.type === 'string' && Array.isArray(entry.warnings)) && Array.isArray(value.warnings);
}

function uint32(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff; }
function pageEntry(value: unknown): value is PageEntry {
  return object(value) && ['directory', 'table'].includes(value.level as string) && Number.isInteger(value.index)
    && (value.index as number) >= 0 && (value.index as number) <= 1023 && uint32(value.address) && uint32(value.raw)
    && ['present', 'writable', 'user', 'writeThrough', 'cacheDisable', 'accessed'].every(key => typeof value[key] === 'boolean')
    && ['dirty', 'pageSize', 'global', 'pat'].every(key => value[key] === undefined || typeof value[key] === 'boolean')
    && (value.base === undefined || uint32(value.base)) && (value.reservedBits === undefined || uint32(value.reservedBits));
}
function pagingData(value: unknown): value is PagingData {
  return object(value) && uint32(value.address) && typeof value.mode === 'string' && typeof value.pagingEnabled === 'boolean'
    && ['disabled', 'legacy32'].includes(value.format as string) && uint32(value.cr0) && typeof value.wp === 'boolean' && typeof value.pse === 'boolean'
    && ['cr3', 'cr4', 'directoryBase', 'physicalAddress'].every(key => value[key] === undefined || uint32(value[key]))
    && ['directoryIndex', 'tableIndex', 'offset'].every(key => Number.isInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 0x3fffff)
    && ['identity', 'mapped', 'not-present', 'invalid', 'unsupported'].includes(value.status as string)
    && (value.pageSize === undefined || value.pageSize === 4096 || value.pageSize === 4194304)
    && (value.faultLevel === undefined || value.faultLevel === 'directory' || value.faultLevel === 'table')
    && (value.pde === undefined || pageEntry(value.pde)) && (value.pte === undefined || pageEntry(value.pte))
    && (value.effective === undefined || (object(value.effective) && ['user', 'writable', 'supervisorRead', 'supervisorWrite', 'userRead', 'userWrite'].every(key => typeof (value.effective as Record<string, unknown>)[key] === 'boolean')))
    && Array.isArray(value.warnings) && value.warnings.length <= 32 && value.warnings.every(warning => typeof warning === 'string') && typeof value.explanation === 'string'
    && (['mapped', 'identity'].includes(value.status as string) ? uint32(value.physicalAddress) : value.physicalAddress === undefined);
}
function disassemblyData(value: unknown): value is DisassemblyData {
  return object(value) && uint32(value.address) && uint32(value.pc) && typeof value.mode === 'string' && (value.bits === 16 || value.bits === 32)
    && Number.isSafeInteger(value.nextAddress) && (value.nextAddress as number) >= 0 && (value.nextAddress as number) <= 0x100000000
    && Array.isArray(value.instructions) && value.instructions.length <= 256 && value.instructions.every(entry => object(entry)
      && typeof entry.address === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(entry.address) && typeof entry.instructionBytes === 'string'
      && /^(?:[0-9a-fA-F]{2}){0,15}$/.test(entry.instructionBytes) && typeof entry.instruction === 'string' && entry.instruction.length <= 256
      && Number.isInteger(entry.size) && (entry.size as number) >= 0 && (entry.size as number) <= 15 && entry.instructionBytes.length === (entry.size as number) * 2
      && ((entry.size as number) > 0 || entry.presentationHint === 'invalid'));
}
function instructionBreakpoints(value: unknown): value is { breakpoints: InstructionBreakpoint[] } {
  return object(value) && Array.isArray(value.breakpoints) && value.breakpoints.length <= 1024
    && value.breakpoints.every(entry => object(entry) && uint32(entry.address) && typeof entry.verified === 'boolean' && ['native', 'custom', 'both'].includes(entry.origin as string));
}
function watchpointData(value: unknown): value is WatchpointData {
  return object(value) && Array.isArray(value.breakpoints) && value.breakpoints.length <= 64
    && (value.warnings === undefined || (Array.isArray(value.warnings) && value.warnings.length <= 8 && value.warnings.every(warning => typeof warning === 'string' && warning.length <= 1024)))
    && value.breakpoints.every(entry => object(entry) && Number.isSafeInteger(entry.id) && typeof entry.dataId === 'string' && uint32(entry.address)
      && [1, 2, 4].includes(entry.size as number) && ['write', 'read', 'readWrite'].includes(entry.access as string) && typeof entry.verified === 'boolean' && ['native', 'custom', 'both'].includes(entry.origin as string))
    && (value.lastHit === undefined || (object(value.lastHit) && uint32(value.lastHit.address) && uint32(value.lastHit.pc) && ['write', 'read', 'readWrite'].includes(value.lastHit.access as string) && Array.isArray(value.lastHit.ids) && value.lastHit.ids.every(Number.isSafeInteger)));
}

/** Coalesces reads while guarding every response with session, stop and form generations. */
export class InspectorModel {
  private session?: InspectorSession;
  private generation = 0;
  private visible = false;
  private inFlight = false;
  private mutating = false;
  private pending = false;
  private disposed = false;
  private seen = new Map<string, number>();
  private state: InspectorSnapshot = {
    generation: 0, form: { tab: 'memory', address: 0x7c00, follow: 'address', memorySpace: 'virtual', pagingAddress: 0x7c00, gdtStart: 0, idtStart: 0, disassemblyAddress: 0x7c00, disassemblyFollow: true },
    status: 'idle', busy: false, stale: false, message: '启动 QEMU 汇编调试并暂停后，在这里观察指令、内存和断点。',
  };
  constructor(private readonly render: (state: InspectorSnapshot) => void) {}
  get snapshot(): InspectorSnapshot { return this.state; }
  isSession(id: string): boolean { return this.session?.id === id; }
  setSession(session?: InspectorSession): void {
    if (this.disposed || this.session?.id === session?.id) return;
    this.session = session; this.generation += 1; this.pending = false; this.seen.clear();
    this.state = { generation: this.generation, sessionId: session?.id, form: this.state.form, status: session ? 'running' : 'idle', busy: false, stale: false,
      message: session ? '程序正在运行，暂停后自动读取。' : '尚未启动 QEMU 汇编调试。' };
    this.emit();
  }
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) this.refresh();
  }
  configure(value: Partial<InspectorForm>): void {
    if (this.disposed) return;
    const form = { ...this.state.form, ...validForm(value) };
    if (form.memorySpace === 'physical') form.follow = 'address';
    if (JSON.stringify(form) === JSON.stringify(this.state.form)) { this.emit(); return; }
    this.generation += 1;
    this.state = { ...this.state, form, stale: true, busy: false };
    this.refresh();
  }
  request(command: string): void {
    if (command === 'restart' || command === 'launch') {
      this.seen.clear(); this.state = { ...this.state, memory: undefined, gdt: undefined, idt: undefined, disassembly: undefined, watchpoints: undefined, instructionBreakpoints: undefined, paging: undefined };
      this.running();
    } else if (motion.has(command) || command === 'disconnect' || command === 'terminate') this.running();
  }
  running(): void {
    if (!this.session || this.disposed) return;
    this.generation += 1; this.pending = false;
    this.state = { ...this.state, status: 'running', busy: false, stale: true, message: '程序正在运行；显示的是上次暂停时的快照。' };
    this.emit();
  }
  stopped(): void {
    if (!this.session || this.disposed) return;
    this.generation += 1;
    this.state = { ...this.state, status: 'stopped', busy: false, stale: true, message: '程序已暂停。' };
    this.refresh();
  }
  refresh(): void {
    if (this.disposed) return;
    this.emit();
    if (!this.visible || !this.session || this.state.status !== 'stopped') return;
    this.pending = true;
    if (!this.inFlight && !this.mutating) void this.read();
  }
  private async read(): Promise<void> {
    if (this.disposed || this.mutating || !this.pending || !this.session || !this.visible || this.state.status !== 'stopped') return;
    this.pending = false; this.inFlight = true;
    const generation = this.generation; const session = this.session; const form = { ...this.state.form };
    this.state = { ...this.state, busy: true, message: '正在读取暂停时的快照…' }; this.emit();
    try {
      let value: unknown;
      let instructionState: unknown;
      if (form.tab === 'memory') value = await session.customRequest('qemuAsm.inspectMemory', { address: form.address, count: form.follow === 'address' ? Math.min(256, 0x100000000 - form.address) : 256, follow: form.follow, space: form.memorySpace });
      else if (form.tab === 'paging') value = await session.customRequest('qemuAsm.inspectPaging', { address: form.pagingAddress });
      else if (form.tab === 'gdt' || form.tab === 'idt') value = await session.customRequest('qemuAsm.inspectDescriptors', { table: form.tab, start: form.tab === 'gdt' ? form.gdtStart : form.idtStart, count: 64 });
      else if (form.tab === 'disassembly') [value, instructionState] = await Promise.all([
        session.customRequest('qemuAsm.disassemble', { ...(form.disassemblyFollow ? {} : { address: form.disassemblyAddress }), count: 64 }),
        session.customRequest('qemuAsm.instructionBreakpoints', { action: 'list' }),
      ]);
      else value = await session.customRequest('qemuAsm.watchpoints', { action: 'list' });
      if (!this.current(session, generation)) return;
      if (form.tab === 'memory') {
        if (!memoryData(value)) throw new Error('调试器返回了无效的内存快照');
        if (value.space !== form.memorySpace || (value.space === 'physical' && value.follow !== 'address')) throw new Error('调试器返回的内存地址空间不匹配');
        const mappings = value.pageMappings;
        if (value.space === 'virtual' && value.pagingEnabled && value.bytes.some((_, offset) => !mappings.some(mapping => mapping.virtualPage === Math.floor((value.address + offset) / 4096) * 4096))) throw new Error('调试器返回的分页内存快照缺少物理映射');
        const key = (offset: number) => {
          const address = value.address + offset;
          const physicalPage = value.space === 'virtual' && value.pagingEnabled ? mappings.find(mapping => mapping.virtualPage === Math.floor(address / 4096) * 4096)?.physicalPage : '';
          return `${value.space}:${value.addressContext}:${physicalPage}:${address}`;
        };
        const changed = value.bytes.map((byte, index) => this.seen.has(key(index)) && this.seen.get(key(index)) !== byte);
        for (let index = 0; index < value.bytes.length; index += 1) this.seen.set(key(index), value.bytes[index]);
        while (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
        this.state = { ...this.state, memory: { ...value, changed }, stale: false, busy: false, message: `已暂停 · ${value.mode} · ${value.space === 'physical' ? '物理' : '虚拟'}内存 · ${value.bytes.length} 字节` };
      } else if (form.tab === 'paging') {
        if (!pagingData(value)) throw new Error('调试器返回了无效的页表快照');
        this.state = { ...this.state, paging: value, stale: false, busy: false, message: `已暂停 · ${value.mode} · ${value.pagingEnabled ? '32 位分页' : '分页未开启'}` };
      } else if (form.tab === 'disassembly') {
        if (!disassemblyData(value) || !instructionBreakpoints(instructionState)) throw new Error('调试器返回了无效的反汇编快照');
        this.state = { ...this.state, disassembly: value, instructionBreakpoints: instructionState.breakpoints, stale: false, busy: false, message: `已暂停 · ${value.mode} · ${value.bits} 位 · ${value.instructions.length} 条指令` };
      } else if (form.tab === 'watchpoints') {
        if (!watchpointData(value)) throw new Error('调试器返回了无效的数据断点快照');
        this.state = { ...this.state, watchpoints: value, stale: false, busy: false, message: `已暂停 · ${value.breakpoints.length} 个数据断点${value.lastHit ? ' · 已命中数据断点' : ''}` };
      } else {
        if (!descriptorData(value, form.tab)) throw new Error('调试器返回了无效的描述符表快照');
        this.state = { ...this.state, [form.tab]: value, stale: false, busy: false, message: `已暂停 · ${value.mode} · ${value.totalEntries} 项` };
      }
      this.emit();
    } catch (error) {
      if (this.current(session, generation)) {
        this.state = { ...this.state, busy: false, stale: true, message: error instanceof Error ? error.message : String(error) }; this.emit();
      }
    } finally {
      this.inFlight = false;
      if (this.pending) void this.read();
    }
  }
  /** Mutations invalidate outstanding snapshots and are only accepted at a confirmed stop. */
  async changeInstructionBreakpoint(address: number, enabled: boolean): Promise<void> {
    if (!uint32(address)) return;
    await this.mutate('qemuAsm.instructionBreakpoints', { action: enabled ? 'add' : 'remove', address });
  }
  async changeWatchpoint(action: 'add' | 'remove' | 'clear', args: { address?: number; size?: number; access?: WatchAccess; id?: number }): Promise<void> {
    if (action === 'add' && (!uint32(args.address) || ![1, 2, 4].includes(args.size!) || !['write', 'read', 'readWrite'].includes(args.access!))) return;
    if (action === 'remove' && !Number.isSafeInteger(args.id)) return;
    await this.mutate('qemuAsm.watchpoints', { action, ...args });
  }
  private async mutate(command: string, args: object): Promise<void> {
    if (this.disposed || this.mutating || !this.visible || !this.session || this.state.status !== 'stopped') return;
    const session = this.session; const generation = ++this.generation;
    this.mutating = true; this.pending = false;
    this.state = { ...this.state, busy: true, stale: true, message: '正在更新断点…' }; this.emit();
    try {
      const value = await session.customRequest(command, args);
      if (!this.current(session, generation)) return;
      if (command === 'qemuAsm.watchpoints') {
        if (!watchpointData(value)) throw new Error('调试器返回了无效的数据断点状态');
        this.state = { ...this.state, watchpoints: value };
      } else {
        if (!instructionBreakpoints(value)) throw new Error('调试器返回了无效的指令断点状态');
        this.state = { ...this.state, instructionBreakpoints: value.breakpoints };
      }
      this.pending = true;
    } catch (error) {
      if (this.current(session, generation)) {
        this.state = { ...this.state, message: error instanceof Error ? error.message : String(error) }; this.emit();
      }
    } finally {
      this.mutating = false;
      if (this.current(session, generation)) { this.state = { ...this.state, busy: false }; this.emit(); }
      if (this.pending) void this.read();
    }
  }
  private current(session: InspectorSession, generation: number): boolean {
    return !this.disposed && this.session === session && this.generation === generation && this.visible && this.state.status === 'stopped';
  }
  private emit(): void { if (!this.disposed) { this.state = { ...this.state, generation: this.generation, sessionId: this.session?.id }; this.render(this.state); } }
  dispose(): void { this.disposed = true; this.generation += 1; this.session = undefined; this.pending = false; this.seen.clear(); }
}
