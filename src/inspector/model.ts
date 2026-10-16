import { InspectorSnapshots, readInspectorSnapshot } from './snapshots';
import type { InspectorForm, InspectorSession, InspectorSnapshot, WatchAccess } from './types';
import { instructionBreakpoints, uint32, validForm, watchpointData } from './validation';
export * from './types';
export { parseAddress } from './validation';
const motion = new Set(['continue', 'next', 'stepIn', 'stepOut', 'reverseContinue', 'stepBack']);
export class InspectorModel {
  private session?: InspectorSession;
  private generation = 0;
  private visible = false;
  private inFlight = false;
  private mutating = false;
  private pending = false;
  private disposed = false;
  private readonly snapshots = new InspectorSnapshots();
  private state: InspectorSnapshot = {
    generation: 0,
    form: {
      tab: 'memory',
      address: 0x7c00,
      follow: 'address',
      memorySpace: 'virtual',
      pagingAddress: 0x7c00,
      gdtStart: 0,
      idtStart: 0,
      disassemblyAddress: 0x7c00,
      disassemblyFollow: true
    },
    status: 'idle',
    busy: false,
    stale: false,
    message: '启动 QEMU 汇编调试并暂停后，在这里观察指令、内存和断点。'
  };
  constructor(private readonly render: (state: InspectorSnapshot) => void) {}
  get snapshot(): InspectorSnapshot {
    return this.state;
  }
  isSession(id: string): boolean {
    return this.session?.id === id;
  }
  setSession(session?: InspectorSession): void {
    if (this.disposed || this.session?.id === session?.id) return;
    this.session = session;
    this.generation += 1;
    this.pending = false;
    this.snapshots.clear();
    this.state = {
      generation: this.generation,
      sessionId: session?.id,
      form: this.state.form,
      status: session ? 'running' : 'idle',
      busy: false,
      stale: false,
      message: session ? '程序正在运行，暂停后自动读取。' : '尚未启动 QEMU 汇编调试。'
    };
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
    if (JSON.stringify(form) === JSON.stringify(this.state.form)) {
      this.emit();
      return;
    }
    this.generation += 1;
    this.state = { ...this.state, form, stale: true, busy: false };
    this.refresh();
  }
  request(command: string): void {
    if (command === 'restart' || command === 'launch') {
      this.snapshots.clear();
      this.state = {
        ...this.state,
        memory: undefined,
        gdt: undefined,
        idt: undefined,
        disassembly: undefined,
        watchpoints: undefined,
        instructionBreakpoints: undefined,
        paging: undefined
      };
      this.running();
    } else if (motion.has(command) || command === 'disconnect' || command === 'terminate') this.running();
  }
  running(): void {
    if (!this.session || this.disposed) return;
    this.generation += 1;
    this.pending = false;
    this.state = {
      ...this.state,
      status: 'running',
      busy: false,
      stale: true,
      message: '程序正在运行；显示的是上次暂停时的快照。'
    };
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
    if (
      this.disposed ||
      this.mutating ||
      !this.pending ||
      !this.session ||
      !this.visible ||
      this.state.status !== 'stopped'
    )
      return;
    this.pending = false;
    this.inFlight = true;
    const generation = this.generation;
    const session = this.session;
    const form = { ...this.state.form };
    this.state = { ...this.state, busy: true, message: '正在读取暂停时的快照…' };
    this.emit();
    try {
      const raw = await readInspectorSnapshot(session, form);
      if (!this.current(session, generation)) return;
      this.state = { ...this.state, ...this.snapshots.apply(form, raw) };
      this.emit();
    } catch (error) {
      if (this.current(session, generation)) {
        this.state = {
          ...this.state,
          busy: false,
          stale: true,
          message: error instanceof Error ? error.message : String(error)
        };
        this.emit();
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
  async changeWatchpoint(
    action: 'add' | 'remove' | 'clear',
    args: { address?: number; size?: number; access?: WatchAccess; id?: number }
  ): Promise<void> {
    if (
      action === 'add' &&
      (!uint32(args.address) ||
        ![1, 2, 4].includes(args.size!) ||
        !['write', 'read', 'readWrite'].includes(args.access!))
    )
      return;
    if (action === 'remove' && !Number.isSafeInteger(args.id)) return;
    await this.mutate('qemuAsm.watchpoints', { action, ...args });
  }
  private async mutate(command: string, args: object): Promise<void> {
    if (this.disposed || this.mutating || !this.visible || !this.session || this.state.status !== 'stopped')
      return;
    const session = this.session;
    const generation = ++this.generation;
    this.mutating = true;
    this.pending = false;
    this.state = { ...this.state, busy: true, stale: true, message: '正在更新断点…' };
    this.emit();
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
        this.state = { ...this.state, message: error instanceof Error ? error.message : String(error) };
        this.emit();
      }
    } finally {
      this.mutating = false;
      if (this.current(session, generation)) {
        this.state = { ...this.state, busy: false };
        this.emit();
      }
      if (this.pending) void this.read();
    }
  }
  private current(session: InspectorSession, generation: number): boolean {
    return (
      !this.disposed &&
      this.session === session &&
      this.generation === generation &&
      this.visible &&
      this.state.status === 'stopped'
    );
  }
  private emit(): void {
    if (!this.disposed) {
      this.state = { ...this.state, generation: this.generation, sessionId: this.session?.id };
      this.render(this.state);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.session = undefined;
    this.pending = false;
    this.snapshots.clear();
  }
}
