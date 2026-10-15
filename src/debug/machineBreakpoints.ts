import { DataWatchpoint, WatchAccess } from './runtime';

export interface MachineBreakpoint { id: number; address: number; verified: boolean; origin: 'native' | 'custom' | 'both'; message?: string }
export interface WatchBreakpoint extends MachineBreakpoint, DataWatchpoint { dataId: string }
interface NativeResult { id?: number; verified: boolean; instructionReference?: string; message?: string }
type Apply<T> = (points: T[]) => Promise<void>;
const addressText = (address: number) => `0x${address.toString(16).toUpperCase()}`;
export function machineAddress(value: unknown): number {
  if (typeof value === 'string' && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value.trim())) value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('地址必须是有效的 32 位整数，支持十进制或 0x 十六进制');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('断点参数必须是对象');
  return value as Record<string, unknown>;
}
export function watchpoint(value: unknown): DataWatchpoint {
  const args = record(value), address = machineAddress(args.address);
  if (![1, 2, 4].includes(Number(args.size)) || typeof args.size !== 'number') throw new Error('数据断点长度必须为 1、2 或 4 字节');
  if (address + args.size > 0x100000000) throw new Error('数据断点范围不能超出 32 位地址空间');
  if (!['read', 'write', 'readWrite'].includes(String(args.access))) throw new Error('数据断点访问类型必须是 read、write 或 readWrite');
  return { address, size: args.size as 1 | 2 | 4, access: args.access as WatchAccess };
}
export function memoryDataId(address: number, size: number): string { return `qemu-mem:${address.toString(16)}:${size}`; }
export function parseMemoryDataId(value: unknown): { address: number; size: 1 | 2 | 4 } {
  if (typeof value !== 'string' || !/^qemu-mem:[0-9a-f]{1,8}:[124]$/i.test(value)) throw new Error('不支持的数据断点标识；请重新选择内存地址');
  const [, rawAddress, rawSize] = value.split(':');
  const point = watchpoint({ address: Number.parseInt(rawAddress, 16), size: Number(rawSize), access: 'write' });
  return { address: point.address, size: point.size };
}
const key = (point: DataWatchpoint) => `${point.address}:${point.size}:${point.access}`;

/** Native DAP lists and custom-panel lists retain separate ownership. Commits follow successful runtime installation. */
export class MachineBreakpoints {
  private nativeInstructions = new Set<number>();
  private customInstructions = new Set<number>();
  private nativeWatches = new Map<string, DataWatchpoint>();
  private customWatches = new Map<string, DataWatchpoint>();
  private ids = new Map<string, number>();
  private serial = 1000;
  private id(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) { id = this.serial++; this.ids.set(name, id); }
    return id;
  }
  instructionAddresses(): number[] { return [...new Set([...this.nativeInstructions, ...this.customInstructions])]; }
  dataPoints(): DataWatchpoint[] { return [...new Map([...this.nativeWatches, ...this.customWatches]).values()]; }
  instructions(): { breakpoints: MachineBreakpoint[] } {
    return { breakpoints: this.instructionAddresses().sort((a, b) => a - b).map(address => ({ id: this.id(`instruction:${address}`), address, verified: true,
      origin: this.nativeInstructions.has(address) ? this.customInstructions.has(address) ? 'both' : 'native' : 'custom' })) };
  }
  watches(): { breakpoints: WatchBreakpoint[] } {
    return { breakpoints: this.dataPoints().sort((a, b) => a.address - b.address || a.size - b.size || a.access.localeCompare(b.access)).map(point => ({ ...point,
      id: this.id(`data:${key(point)}`), dataId: memoryDataId(point.address, point.size), verified: true,
      origin: this.nativeWatches.has(key(point)) ? this.customWatches.has(key(point)) ? 'both' : 'native' : 'custom' })) };
  }
  instructionHit(address: number): number[] { return this.instructionAddresses().includes(address) ? [this.id(`instruction:${address}`)] : []; }
  dataHits(address: number, access: WatchAccess): number[] {
    // QEMU reports the configured watchpoint start and kind, not the access's
    // starting address or exact transfer size. Equal-start/size variants may
    // therefore have multiple candidate IDs; nearby overlapping starts do not.
    return this.watches().breakpoints.filter(point => address === point.address && point.access === access).map(point => point.id);
  }
  async setNativeInstructions(value: unknown, apply: Apply<number>): Promise<NativeResult[]> {
    const inputs = this.array(value, 256), desired = new Set<number>();
    const results: NativeResult[] = inputs.map(value => {
      try {
        const args = record(value);
        if (args.condition !== undefined || args.hitCondition !== undefined) throw new Error('指令断点暂不支持条件或命中次数');
        const offset = args.offset === undefined ? 0 : args.offset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || Math.abs(offset) > 0xffffffff) throw new Error('指令断点偏移必须是有效整数');
        const address = machineAddress(machineAddress(args.instructionReference) + offset); desired.add(address);
        return { id: this.id(`instruction:${address}`), verified: true, instructionReference: addressText(address) };
      } catch (error) { return { verified: false, message: String(error instanceof Error ? error.message : error) }; }
    });
    const union = [...new Set([...desired, ...this.customInstructions])];
    if (union.length > 256) throw new Error('最多设置 256 个指令断点');
    await apply(union);
    this.nativeInstructions = desired;
    return results;
  }
  async changeInstruction(value: unknown, apply: Apply<number>): Promise<{ breakpoints: MachineBreakpoint[] }> {
    const args = record(value), desired = new Set(this.customInstructions);
    if (args.action === 'list') return this.instructions();
    if (args.action === 'clear') desired.clear();
    else if (args.action === 'add' || args.action === 'remove') {
      const address = machineAddress(args.address);
      if (args.action === 'add') desired.add(address); else desired.delete(address);
    } else throw new Error('无效的指令断点操作');
    if (new Set([...this.nativeInstructions, ...desired]).size > 256) throw new Error('最多设置 256 个指令断点');
    await apply([...new Set([...this.nativeInstructions, ...desired])]);
    this.customInstructions = desired;
    return this.instructions();
  }
  async setNativeWatches(value: unknown, apply: Apply<DataWatchpoint>): Promise<NativeResult[]> {
    const inputs = this.array(value, 16), desired = new Map<string, DataWatchpoint>();
    const results: NativeResult[] = inputs.map(value => {
      try {
        const args = record(value);
        if (args.condition !== undefined || args.hitCondition !== undefined) throw new Error('数据断点暂不支持条件或命中次数');
        const target = parseMemoryDataId(args.dataId);
        const point = watchpoint({ ...target, access: args.accessType ?? 'write' }); desired.set(key(point), point);
        return { id: this.id(`data:${key(point)}`), verified: true };
      } catch (error) { return { verified: false, message: String(error instanceof Error ? error.message : error) }; }
    });
    const union = [...new Map([...desired, ...this.customWatches]).values()];
    if (union.length > 16) throw new Error('最多设置 16 个数据断点');
    await apply(union); this.nativeWatches = desired;
    return results;
  }
  async changeWatch(value: unknown, apply: Apply<DataWatchpoint>): Promise<{ breakpoints: WatchBreakpoint[] }> {
    const args = record(value), desired = new Map(this.customWatches);
    if (args.action === 'list') return this.watches();
    if (args.action === 'clear') desired.clear();
    else if (args.action === 'add') { const point = watchpoint(args); desired.set(key(point), point); }
    else if (args.action === 'remove') {
      if (typeof args.id !== 'number' || !Number.isSafeInteger(args.id)) throw new Error('删除数据断点须指定断点 ID');
      for (const point of desired.values()) if (this.id(`data:${key(point)}`) === args.id) desired.delete(key(point));
    } else throw new Error('无效的数据断点操作');
    const union = [...new Map([...this.nativeWatches, ...desired]).values()];
    if (union.length > 16) throw new Error('最多设置 16 个数据断点');
    await apply(union); this.customWatches = desired;
    return this.watches();
  }
  private array(value: unknown, maximum: number): unknown[] {
    if (!Array.isArray(value) || value.length > maximum) throw new Error(`断点列表必须是最多 ${maximum} 项的数组`);
    return value;
  }
}
