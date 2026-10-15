import type { DescriptorEntry } from '../inspection';
import { boundedInteger } from '../validation';
export const segmentNames = ['cs', 'ds', 'es', 'fs', 'gs', 'ss'] as const;
/** Decode one legacy 8-byte GDT descriptor without assuming it is a segment. */
export function decodeGdtEntry(
  bytes: Buffer,
  index = 0,
  registers?: Record<string, number>
): DescriptorEntry {
  exactBytes(bytes, 8);
  boundedInteger(index, 0, 8191, 'GDT 索引');
  const entry = common(bytes, index);
  entry.selector = index * 8;
  entry.registers = [];
  entry.cacheWarnings = [];
  if (index === 0) {
    entry.kind = 'null';
    entry.type = '空描述符';
    entry.present = false;
    if (bytes.some((value) => value !== 0))
      entry.warnings.push('GDT 第 0 项始终是空选择子，其字节不会作为段描述符使用。');
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
    entry.type = (
      { 1: '16 位可用 TSS', 2: 'LDT', 3: '16 位忙 TSS', 9: '32 位可用 TSS', 11: '32 位忙 TSS' } as Record<
        number,
        string
      >
    )[type];
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
    entry.kind = 'reserved';
    entry.type = `保留的系统描述符 0x${type.toString(16)}`;
    invalid(entry, '该系统描述符类型不能用于 32 位 GDT。');
  }
  if (registers && (registers.cr0 ?? 0) & 1) {
    for (const name of segmentNames) {
      const selector = registers[name];
      if (!Number.isInteger(selector) || selector & 4 || (selector & 0xfff8) !== index * 8) continue;
      entry.registers.push(name.toUpperCase());
      if (entry.kind !== 'code' && entry.kind !== 'data') {
        entry.cacheWarnings.push(
          `${name.toUpperCase()} 隐藏缓存仍保存已加载的段；当前 GDT 条目已不是代码/数据段。`
        );
        continue;
      }
      const mismatch: string[] = [];
      if (
        entry.base !== undefined &&
        registers[`${name}_base`] !== undefined &&
        registers[`${name}_base`] !== entry.base
      )
        mismatch.push('基址');
      if (
        entry.effectiveLimit !== undefined &&
        registers[`${name}_limit`] !== undefined &&
        registers[`${name}_limit`] !== entry.effectiveLimit
      )
        mismatch.push('界限');
      const cached = registers[`${name}_flags`];
      // The CPU may set Accessed after loading a segment; that alone is not stale state.
      if (
        entry.base !== undefined &&
        cached !== undefined &&
        (cached & 0xf0fe00) !== (((bytes[5] << 8) | (bytes[6] << 16)) & 0xf0fe00)
      )
        mismatch.push('属性');
      if (mismatch.length)
        entry.cacheWarnings.push(
          `${name.toUpperCase()} 隐藏缓存的${mismatch.join('、')}与当前 GDT 条目不同；修改表不会自动重载段寄存器。`
        );
    }
  }
  return entry;
}

/** Real mode uses 4-byte IVT far pointers; protected mode uses legacy 8-byte gates. */
export function decodeIdtEntry(bytes: Buffer, index = 0, format: 'idt' | 'ivt' = 'idt'): DescriptorEntry {
  exactBytes(bytes, format === 'ivt' ? 4 : 8);
  boundedInteger(index, 0, 255, '中断向量');
  if (format === 'ivt')
    return {
      index,
      address: 0,
      raw: bytes.toString('hex'),
      kind: 'real-mode-vector',
      type: '实模式中断向量',
      present: true,
      dpl: 0,
      valid: true,
      warnings: [],
      offset: bytes.readUInt16LE(0),
      selector: bytes.readUInt16LE(2),
      gateBits: 16
    };
  const entry = common(bytes, index);
  decodeGate(entry, bytes, 'idt');
  return entry;
}

function common(bytes: Buffer, index: number): DescriptorEntry {
  return {
    index,
    address: 0,
    raw: bytes.toString('hex'),
    kind: 'reserved',
    type: '保留',
    present: !!(bytes[5] & 0x80),
    dpl: (bytes[5] >>> 5) & 3,
    valid: true,
    warnings: []
  };
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
    entry.kind = 'reserved';
    entry.type = `保留的${table.toUpperCase()} 类型 0x${type.toString(16)}`;
    invalid(entry, '该门类型或 S 位不适用于此表。');
    return;
  }
  entry.selector = bytes.readUInt16LE(2);
  if (type === 5) {
    entry.kind = 'task-gate';
    entry.type = '任务门';
    if (bytes.readUInt16LE(0) || bytes[4] || bytes.readUInt16LE(6))
      invalid(entry, '任务门的保留字段必须为 0。');
  } else {
    const wide = [12, 14, 15].includes(type);
    entry.gateBits = wide ? 32 : 16;
    entry.kind = [4, 12].includes(type)
      ? 'call-gate'
      : [6, 14].includes(type)
        ? 'interrupt-gate'
        : 'trap-gate';
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

function invalid(entry: DescriptorEntry, warning: string): void {
  entry.valid = false;
  entry.warnings.push(warning);
}
function exactBytes(bytes: Buffer, size: number): void {
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new Error(`描述符必须恰好包含 ${size} 字节`);
}
