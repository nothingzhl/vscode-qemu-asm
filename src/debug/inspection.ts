import { CpuMode, cpuMode, instructionAddress, stackAddress } from './runtime';
import { walkPaging } from './paging';

/** Only paused, read-only runtime operations are exposed to the inspector. */
export interface InspectionRuntime {
  registers(): Promise<Record<string, number>>;
  readMemory(address: number, count: number): Promise<Buffer>;
  readPhysicalMemory?(address: number, count: number): Promise<Buffer>;
}

export interface MemoryInspectionArgs {
  address?: number | string;
  count?: number;
  follow?: 'address' | 'esp' | 'ebp';
  space?: 'virtual' | 'physical';
}

export interface MemorySnapshot {
  address: number;
  count: number;
  bytes: number[];
  mode: CpuMode;
  follow: 'address' | 'esp' | 'ebp';
  space: 'virtual' | 'physical';
  pagingEnabled: boolean;
  cr3?: number;
  cr4?: number;
  /** Separates histories by address space and paging context. */
  addressContext: string;
  /** Current 4 KiB backing pages; diff histories also key each byte by its page. */
  pageMappings: { virtualPage: number; physicalPage: number }[];
  registers: { esp: number; ebp: number; ss: number; ss_base?: number };
}

export interface DescriptorInspectionArgs {
  table: 'gdt' | 'idt';
  start?: number;
  count?: number;
}

/** Decoded fields are optional because gates, segments and null entries differ. */
export interface DescriptorEntry {
  index: number;
  address: number;
  raw: string;
  kind: string;
  type: string;
  present: boolean;
  dpl: number;
  valid: boolean;
  warnings: string[];
  /** GDT entry identity (index * 8), or the target selector for an IDT/IVT entry. */
  selector?: number;
  /** Only GDT gates need a target distinct from their own selector. */
  targetSelector?: number;
  base?: number;
  rawLimit?: number;
  effectiveLimit?: number;
  granularity?: boolean;
  defaultBits?: 16 | 32;
  code?: boolean;
  readable?: boolean;
  writable?: boolean;
  conforming?: boolean;
  expandDown?: boolean;
  accessed?: boolean;
  available?: boolean;
  longMode?: boolean;
  registers?: string[];
  cacheWarnings?: string[];
  offset?: number;
  gateBits?: 16 | 32;
  parameterCount?: number;
}

export interface DescriptorSnapshot {
  table: 'gdt' | 'idt';
  format: 'gdt' | 'idt' | 'ivt';
  mode: CpuMode;
  base: number;
  limit: number;
  entrySize: 4 | 8;
  totalEntries: number;
  start: number;
  count: number;
  entries: DescriptorEntry[];
  warnings: string[];
}

const segmentNames = ['cs', 'ds', 'es', 'fs', 'gs', 'ss'] as const;

/** Addresses are decimal or explicit 0x-prefixed hexadecimal, never JS expressions. */
export function inspectionAddress(value: number | string): number {
  let address: number;
  if (typeof value === 'number') address = value;
  else if (typeof value === 'string' && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value.trim())) address = Number(value.trim());
  else throw new Error('内存地址必须是十进制或 0x 开头的 32 位地址');
  unsigned32(address, '内存地址');
  return address;
}

export async function inspectMemory(runtime: InspectionRuntime, args: unknown = {}): Promise<MemorySnapshot> {
  objectArgs(args);
  const request = args as MemoryInspectionArgs;
  const follow = request.follow === undefined ? 'address' : request.follow;
  if (!['address', 'esp', 'ebp'].includes(follow)) throw new Error('内存跟随方式必须是 address、esp 或 ebp');
  const space = request.space === undefined ? 'virtual' : request.space;
  if (space !== 'virtual' && space !== 'physical') throw new Error('内存地址空间必须是 virtual 或 physical');
  if (space === 'physical' && follow !== 'address') throw new Error('物理内存模式仅接受显式物理地址；请切换地址模式，不能直接把 ESP/EBP 线性地址当作物理地址');
  const count = boundedInteger(request.count === undefined ? 256 : request.count, 1, 4096, '内存读取长度');
  // Validate even an unused address so malformed messages cannot change meaning silently.
  const requested = request.address === undefined ? undefined : inspectionAddress(request.address);
  if (space === 'physical' && requested === undefined) throw new Error('物理内存模式需要显式物理地址');
  const registers = await runtime.registers();
  const mode = cpuMode(registers);
  const address = follow === 'esp' ? stackAddress(registers) : follow === 'ebp' ? stackAddress(registers, registers.ebp) : requested ?? instructionAddress(registers);
  memoryRange(address, count);
  const bytes = await readExact(runtime, address, count, space);
  const pagingEnabled = !!((registers.cr0 ?? 0) & 0x80000000);
  let addressContext = space === 'physical' ? 'physical' : 'virtual:unpaged';
  const pageMappings: MemorySnapshot['pageMappings'] = [];
  if (space === 'virtual' && pagingEnabled) {
    // Including each touched 4 KiB backing page avoids calling a page remap a
    // byte change when guest code rewrites a PTE without changing CR3.
    const physicalRuntime = { readPhysicalMemory: (location: number, length: number) => readExact(runtime, location, length, 'physical') };
    for (let page = Math.floor(address / 4096) * 4096; page < address + count; page += 4096) {
      const mapping = await walkPaging(physicalRuntime, registers, page);
      if (mapping.physicalAddress === undefined) throw new Error(`无法确定虚拟内存的物理映射：${mapping.explanation}`);
      pageMappings.push({ virtualPage: page, physicalPage: mapping.physicalAddress });
    }
    addressContext = `virtual:legacy32:${registers.cr3}:${registers.cr4}`;
  }
  return { address, count, bytes: [...bytes], mode, follow, space, pagingEnabled, cr3: registers.cr3, cr4: registers.cr4, addressContext, pageMappings,
    registers: { esp: registers.esp, ebp: registers.ebp, ss: registers.ss, ss_base: registers.ss_base } };
}

export async function inspectDescriptors(runtime: InspectionRuntime, args: unknown): Promise<DescriptorSnapshot> {
  objectArgs(args);
  const request = args as DescriptorInspectionArgs;
  if (request.table !== 'gdt' && request.table !== 'idt') throw new Error('描述符表必须是 gdt 或 idt');
  const start = boundedInteger(request.start === undefined ? 0 : request.start, 0, request.table === 'gdt' ? 8191 : 255, '描述符起始索引');
  const requestedCount = boundedInteger(request.count === undefined ? 64 : request.count, 1, 128, '描述符读取数量');
  const registers = await runtime.registers();
  const mode = cpuMode(registers);
  const format = request.table === 'gdt' ? 'gdt' : mode === 'real16' ? 'ivt' : 'idt';
  const prefix = request.table === 'gdt' ? 'gdtr' : 'idtr';
  const base = registers[`${prefix}_base`];
  const limit = registers[`${prefix}_limit`];
  unsigned32(base, `${prefix.toUpperCase()} 基址`);
  boundedInteger(limit, 0, 0xffff, `${prefix.toUpperCase()} 界限`);
  const entrySize = format === 'ivt' ? 4 : 8;
  const totalEntries = Math.min(Math.floor((limit + 1) / entrySize), format === 'gdt' ? 8192 : 256);
  const count = Math.max(0, Math.min(requestedCount, totalEntries - start));
  const address = base + start * entrySize;
  // Empty pages never perform a read or manufacture an overflowing end address.
  const bytes = count ? await readExact(runtime, address, count * entrySize) : Buffer.alloc(0);
  const entries: DescriptorEntry[] = [];
  for (let offset = 0; offset < count; offset++) {
    const index = start + offset;
    const entry = format === 'gdt' ? decodeGdtEntry(bytes.subarray(offset * entrySize, (offset + 1) * entrySize), index, registers)
      : decodeIdtEntry(bytes.subarray(offset * entrySize, (offset + 1) * entrySize), index, format);
    entry.address = base + index * entrySize;
    entries.push(entry);
  }
  const warnings: string[] = [];
  if (format === 'gdt' && mode === 'real16') warnings.push('当前为实模式；GDTR 可以读取，但段寄存器不使用 GDT。');
  if (format === 'gdt' && mode !== 'real16') {
    for (const name of segmentNames) if (Number.isInteger(registers[name]) && registers[name] & 4) warnings.push(`${name.toUpperCase()} 的选择子使用 LDT；此视图仅解码 GDT，不把它标记到 GDT 条目。`);
  }
  if ((limit + 1) % entrySize) warnings.push('表界限末尾不足一个完整条目；未读取该部分。');
  if (format !== 'gdt' && Math.floor((limit + 1) / entrySize) > 256) warnings.push('x86 中断向量最多 256 项；已限制显示范围。');
  return { table: request.table, format, mode, base, limit, entrySize, totalEntries, start, count, entries, warnings };
}

/** Decode one legacy 8-byte GDT descriptor without assuming it is a segment. */
export function decodeGdtEntry(bytes: Buffer, index = 0, registers?: Record<string, number>): DescriptorEntry {
  exactBytes(bytes, 8);
  boundedInteger(index, 0, 8191, 'GDT 索引');
  const entry = common(bytes, index);
  entry.selector = index * 8;
  entry.registers = [];
  entry.cacheWarnings = [];
  if (index === 0) {
    entry.kind = 'null'; entry.type = '空描述符'; entry.present = false;
    if (bytes.some(value => value !== 0)) entry.warnings.push('GDT 第 0 项始终是空选择子，其字节不会作为段描述符使用。');
    return entry;
  }
  const access = bytes[5];
  const type = access & 15;
  if (access & 0x10) {
    const code = !!(type & 8);
    entry.kind = code ? 'code' : 'data';
    entry.type = code ? '代码段' : '数据段';
    entry.code = code;
    entry.readable = !code || !!(type & 2);
    entry.writable = !code && !!(type & 2);
    entry.conforming = code && !!(type & 4);
    entry.expandDown = !code && !!(type & 4);
    entry.accessed = !!(type & 1);
    segmentFields(entry, bytes);
    if (entry.longMode && !code) invalid(entry, '数据段的 L 位必须为 0。');
    if (entry.longMode && entry.defaultBits === 32) invalid(entry, '64 位代码段的 L 与 D 位不能同时为 1。');
  } else if ([1, 2, 3, 9, 11].includes(type)) {
    entry.kind = type === 2 ? 'ldt' : 'tss';
    entry.type = ({ 1: '16 位可用 TSS', 2: 'LDT', 3: '16 位忙 TSS', 9: '32 位可用 TSS', 11: '32 位忙 TSS' } as Record<number, string>)[type];
    segmentFields(entry, bytes);
    // D/B and L are reserved here, not a TSS/LDT default operand width.
    delete entry.defaultBits;
    delete entry.longMode;
    if (bytes[6] & 0x60) invalid(entry, 'LDT/TSS 的 L 与 D/B 保留位必须为 0。');
  } else if ([4, 5, 12].includes(type)) {
    decodeGate(entry, bytes, 'gdt');
    entry.targetSelector = entry.selector;
    entry.selector = index * 8;
  } else {
    entry.kind = 'reserved'; entry.type = `保留的系统描述符 0x${type.toString(16)}`;
    invalid(entry, '该系统描述符类型不能用于 32 位 GDT。');
  }
  if (registers && ((registers.cr0 ?? 0) & 1)) {
    for (const name of segmentNames) {
      const selector = registers[name];
      if (!Number.isInteger(selector) || selector & 4 || (selector & 0xfff8) !== index * 8) continue;
      entry.registers.push(name.toUpperCase());
      if (entry.kind !== 'code' && entry.kind !== 'data') {
        entry.cacheWarnings.push(`${name.toUpperCase()} 隐藏缓存仍保存已加载的段；当前 GDT 条目已不是代码/数据段。`);
        continue;
      }
      const mismatch: string[] = [];
      if (entry.base !== undefined && registers[`${name}_base`] !== undefined && registers[`${name}_base`] !== entry.base) mismatch.push('基址');
      if (entry.effectiveLimit !== undefined && registers[`${name}_limit`] !== undefined && registers[`${name}_limit`] !== entry.effectiveLimit) mismatch.push('界限');
      const cached = registers[`${name}_flags`];
      // The CPU may set Accessed after loading a segment; that alone is not stale state.
      if (entry.base !== undefined && cached !== undefined && (cached & 0xf0fe00) !== (((bytes[5] << 8) | (bytes[6] << 16)) & 0xf0fe00)) mismatch.push('属性');
      if (mismatch.length) entry.cacheWarnings.push(`${name.toUpperCase()} 隐藏缓存的${mismatch.join('、')}与当前 GDT 条目不同；修改表不会自动重载段寄存器。`);
    }
  }
  return entry;
}

/** Real mode uses 4-byte IVT far pointers; protected mode uses legacy 8-byte gates. */
export function decodeIdtEntry(bytes: Buffer, index = 0, format: 'idt' | 'ivt' = 'idt'): DescriptorEntry {
  exactBytes(bytes, format === 'ivt' ? 4 : 8);
  boundedInteger(index, 0, 255, '中断向量');
  if (format === 'ivt') return { index, address: 0, raw: bytes.toString('hex'), kind: 'real-mode-vector', type: '实模式中断向量',
    present: true, dpl: 0, valid: true, warnings: [], offset: bytes.readUInt16LE(0), selector: bytes.readUInt16LE(2), gateBits: 16 };
  const entry = common(bytes, index);
  decodeGate(entry, bytes, 'idt');
  return entry;
}

function common(bytes: Buffer, index: number): DescriptorEntry {
  return { index, address: 0, raw: bytes.toString('hex'), kind: 'reserved', type: '保留', present: !!(bytes[5] & 0x80), dpl: (bytes[5] >>> 5) & 3, valid: true, warnings: [] };
}

function segmentFields(entry: DescriptorEntry, bytes: Buffer): void {
  entry.base = (bytes.readUInt16LE(2) | (bytes[4] << 16) | (bytes[7] << 24)) >>> 0;
  entry.rawLimit = bytes.readUInt16LE(0) | ((bytes[6] & 15) << 16);
  entry.granularity = !!(bytes[6] & 0x80);
  entry.effectiveLimit = entry.granularity ? entry.rawLimit * 4096 + 4095 : entry.rawLimit;
  entry.defaultBits = bytes[6] & 0x40 ? 32 : 16;
  entry.longMode = !!(bytes[6] & 0x20);
  entry.available = !!(bytes[6] & 0x10);
}

function decodeGate(entry: DescriptorEntry, bytes: Buffer, table: 'gdt' | 'idt'): void {
  const type = bytes[5] & 15;
  const allowed = table === 'idt' ? [5, 6, 7, 14, 15] : [4, 5, 12];
  if (bytes[5] & 0x10 || !allowed.includes(type)) {
    entry.kind = 'reserved'; entry.type = `保留的${table.toUpperCase()} 类型 0x${type.toString(16)}`;
    invalid(entry, '该门类型或 S 位不适用于此表。');
    return;
  }
  entry.selector = bytes.readUInt16LE(2);
  if (type === 5) {
    entry.kind = 'task-gate'; entry.type = '任务门';
    if (bytes.readUInt16LE(0) || bytes[4] || bytes.readUInt16LE(6)) invalid(entry, '任务门的保留字段必须为 0。');
  } else {
    const wide = [12, 14, 15].includes(type);
    entry.gateBits = wide ? 32 : 16;
    entry.kind = [4, 12].includes(type) ? 'call-gate' : [6, 14].includes(type) ? 'interrupt-gate' : 'trap-gate';
    entry.type = `${entry.gateBits} 位${entry.kind === 'call-gate' ? '调用门' : entry.kind === 'interrupt-gate' ? '中断门' : '陷阱门'}`;
    entry.offset = bytes.readUInt16LE(0) + (wide ? bytes.readUInt16LE(6) * 0x10000 : 0);
    if (!wide && bytes.readUInt16LE(6)) invalid(entry, '16 位门的高 16 位偏移保留字段必须为 0。');
    if (table === 'gdt') {
      entry.parameterCount = bytes[4] & 31;
      if (bytes[4] & 0xe0) invalid(entry, '调用门参数计数字段的高 3 位必须为 0。');
    } else if (bytes[4]) invalid(entry, '中断/陷阱门的保留字节必须为 0。');
  }
  if (!(entry.selector & 0xfffc)) invalid(entry, '门目标不能使用 GDT 空选择子。');
  if (type === 5 && entry.selector & 4) invalid(entry, '任务门的目标 TSS 必须位于 GDT。');
}

function invalid(entry: DescriptorEntry, warning: string): void { entry.valid = false; entry.warnings.push(warning); }
function exactBytes(bytes: Buffer, size: number): void { if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new Error(`描述符必须恰好包含 ${size} 字节`); }
function objectArgs(value: unknown): asserts value is object { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('检查参数必须是对象'); }
function unsigned32(value: number, label: string): void { boundedInteger(value, 0, 0xffffffff, label); }
function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}
function memoryRange(address: number, count: number): void { unsigned32(address, '内存地址'); if (address + count > 0x100000000) throw new Error('内存读取不能超出 32 位地址范围'); }
async function readExact(runtime: InspectionRuntime, address: number, count: number, space: 'virtual' | 'physical' = 'virtual'): Promise<Buffer> {
  memoryRange(address, count);
  if (count > 4096) throw new Error('单次检查最多读取 4096 字节');
  const read = space === 'physical' ? runtime.readPhysicalMemory : runtime.readMemory;
  if (typeof read !== 'function') throw new Error('当前调试运行时不支持物理内存读取');
  const bytes = await read.call(runtime, address, count);
  if (!Buffer.isBuffer(bytes) || bytes.length !== count) throw new Error('运行时返回的检查数据不完整');
  return bytes;
}
