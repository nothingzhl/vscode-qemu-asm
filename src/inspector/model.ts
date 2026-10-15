/** The inspector only reads a stopped guest, and never retains memory in workspace state. */
export type InspectorTab = 'memory' | 'gdt' | 'idt';
export type MemoryFollow = 'address' | 'esp' | 'ebp';
export interface InspectorSession { readonly id: string; customRequest(command: string, args: unknown): Thenable<unknown>; }
export interface InspectorForm { tab: InspectorTab; address: number; follow: MemoryFollow; gdtStart: number; idtStart: number; }
export interface MemoryData { address: number; count: number; bytes: number[]; mode: string; follow: MemoryFollow; changed: boolean[]; }
export interface DescriptorEntry {
  index: number; address: number; raw: string; kind: string; type: string; present: boolean; dpl: number; valid: boolean;
  warnings: string[]; selector?: number; targetSelector?: number; parameterCount?: number; base?: number; effectiveLimit?: number; granularity?: boolean;
  defaultBits?: number; registers?: string[]; cacheWarnings?: string[]; offset?: number; gateBits?: number;
  readable?: boolean; writable?: boolean; conforming?: boolean; expandDown?: boolean; accessed?: boolean;
}
export interface DescriptorData { table: 'gdt' | 'idt'; format: string; mode: string; base: number; limit: number; entrySize: number; totalEntries: number; start: number; count: number; entries: DescriptorEntry[]; warnings: string[]; }
export interface InspectorSnapshot {
  form: InspectorForm; status: 'idle' | 'running' | 'stopped'; busy: boolean; stale: boolean; message: string;
  memory?: MemoryData; gdt?: DescriptorData; idt?: DescriptorData;
}
const motion = new Set(['continue', 'next', 'stepIn', 'stepOut', 'reverseContinue', 'stepBack']);
export function parseAddress(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 32 || !/^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}
function validForm(value: Partial<InspectorForm>): Partial<InspectorForm> {
  const result: Partial<InspectorForm> = {};
  if (value.tab === 'memory' || value.tab === 'gdt' || value.tab === 'idt') result.tab = value.tab;
  if (value.follow === 'address' || value.follow === 'esp' || value.follow === 'ebp') result.follow = value.follow;
  for (const key of ['address', 'gdtStart', 'idtStart'] as const) {
    const max = key === 'address' ? 0xffffffff : 8191;
    if (Number.isInteger(value[key]) && value[key]! >= 0 && value[key]! <= max) result[key] = value[key];
  }
  return result;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function memoryData(value: unknown): value is Omit<MemoryData, 'changed'> {
  return object(value) && Number.isInteger(value.address) && (value.address as number) >= 0 && (value.address as number) <= 0xffffffff
    && Array.isArray(value.bytes) && value.bytes.length <= 256 && value.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && value.count === value.bytes.length && (value.address as number) + value.bytes.length <= 0x100000000
    && typeof value.mode === 'string' && ['address', 'esp', 'ebp'].includes(value.follow as string);
}
function descriptorData(value: unknown, table: 'gdt' | 'idt'): value is DescriptorData {
  return object(value) && value.table === table && typeof value.format === 'string' && typeof value.mode === 'string'
    && Number.isInteger(value.base) && Number.isInteger(value.limit) && Number.isInteger(value.totalEntries)
    && Number.isInteger(value.start) && Number.isInteger(value.count) && Array.isArray(value.entries)
    && value.entries.length <= 64 && value.entries.every(entry => object(entry) && Number.isInteger(entry.index)
      && typeof entry.raw === 'string' && typeof entry.type === 'string' && Array.isArray(entry.warnings)) && Array.isArray(value.warnings);
}

/** Coalesces reads while guarding every response with session, stop and form generations. */
export class InspectorModel {
  private session?: InspectorSession;
  private generation = 0;
  private visible = false;
  private inFlight = false;
  private pending = false;
  private disposed = false;
  private seen = new Map<number, number>();
  private state: InspectorSnapshot = {
    form: { tab: 'memory', address: 0x7c00, follow: 'address', gdtStart: 0, idtStart: 0 },
    status: 'idle', busy: false, stale: false, message: '启动 QEMU 汇编调试并暂停后，在这里观察内存和描述符表。',
  };
  constructor(private readonly render: (state: InspectorSnapshot) => void) {}
  get snapshot(): InspectorSnapshot { return this.state; }
  isSession(id: string): boolean { return this.session?.id === id; }
  setSession(session?: InspectorSession): void {
    if (this.disposed || this.session?.id === session?.id) return;
    this.session = session; this.generation += 1; this.pending = false; this.seen.clear();
    this.state = { form: this.state.form, status: session ? 'running' : 'idle', busy: false, stale: false,
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
    if (JSON.stringify(form) === JSON.stringify(this.state.form)) { this.emit(); return; }
    this.generation += 1;
    this.state = { ...this.state, form, stale: true, busy: false };
    this.refresh();
  }
  request(command: string): void {
    if (command === 'restart' || command === 'launch') {
      this.seen.clear(); this.state = { ...this.state, memory: undefined, gdt: undefined, idt: undefined };
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
    if (!this.inFlight) void this.read();
  }
  private async read(): Promise<void> {
    if (this.disposed || !this.pending || !this.session || !this.visible || this.state.status !== 'stopped') return;
    this.pending = false; this.inFlight = true;
    const generation = this.generation; const session = this.session; const form = { ...this.state.form };
    this.state = { ...this.state, busy: true, message: '正在读取暂停时的快照…' }; this.emit();
    try {
      const value = await session.customRequest(form.tab === 'memory' ? 'qemuAsm.inspectMemory' : 'qemuAsm.inspectDescriptors',
        form.tab === 'memory' ? { address: form.address, count: form.follow === 'address' ? Math.min(256, 0x100000000 - form.address) : 256, follow: form.follow }
          : { table: form.tab, start: form.tab === 'gdt' ? form.gdtStart : form.idtStart, count: 64 });
      if (!this.current(session, generation)) return;
      if (form.tab === 'memory') {
        if (!memoryData(value)) throw new Error('调试器返回了无效的内存快照');
        const changed = value.bytes.map((byte, index) => this.seen.has(value.address + index) && this.seen.get(value.address + index) !== byte);
        for (let index = 0; index < value.bytes.length; index += 1) this.seen.set(value.address + index, value.bytes[index]);
        while (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
        this.state = { ...this.state, memory: { ...value, changed }, stale: false, busy: false, message: `已暂停 · ${value.mode} · ${value.bytes.length} 字节` };
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
  private current(session: InspectorSession, generation: number): boolean {
    return !this.disposed && this.session === session && this.generation === generation && this.visible && this.state.status === 'stopped';
  }
  private emit(): void { if (!this.disposed) this.render(this.state); }
  dispose(): void { this.disposed = true; this.generation += 1; this.session = undefined; this.pending = false; this.seen.clear(); }
}
