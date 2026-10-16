import type { DescriptorEntry, DescriptorInspectionArgs, DescriptorSnapshot } from '../../domain/inspection';
import { decodeGdtEntry, decodeIdtEntry, segmentNames } from '../../domain/x86/descriptors';
import { cpuMode } from '../../domain/x86/state';
import type { InspectionRuntime } from '../../ports/inspection';
import { boundedInteger, objectArgs, readExact, unsigned32 } from './requests';
export async function inspectDescriptors(
  runtime: InspectionRuntime,
  args: unknown
): Promise<DescriptorSnapshot> {
  objectArgs(args);
  const request = args as DescriptorInspectionArgs;
  if (request.table !== 'gdt' && request.table !== 'idt') throw new Error('描述符表必须是 gdt 或 idt');
  const start = boundedInteger(
    request.start === undefined ? 0 : request.start,
    0,
    request.table === 'gdt' ? 8191 : 255,
    '描述符起始索引'
  );
  const requestedCount = boundedInteger(
    request.count === undefined ? 64 : request.count,
    1,
    128,
    '描述符读取数量'
  );
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
    const entry =
      format === 'gdt'
        ? decodeGdtEntry(bytes.subarray(offset * entrySize, (offset + 1) * entrySize), index, registers)
        : decodeIdtEntry(bytes.subarray(offset * entrySize, (offset + 1) * entrySize), index, format);
    entry.address = base + index * entrySize;
    entries.push(entry);
  }
  const warnings: string[] = [];
  if (format === 'gdt' && mode === 'real16')
    warnings.push('当前为实模式；GDTR 可以读取，但段寄存器不使用 GDT。');
  if (format === 'gdt' && mode !== 'real16') {
    for (const name of segmentNames)
      if (Number.isInteger(registers[name]) && registers[name] & 4)
        warnings.push(`${name.toUpperCase()} 的选择子使用 LDT；此视图仅解码 GDT，不把它标记到 GDT 条目。`);
  }
  if ((limit + 1) % entrySize) warnings.push('表界限末尾不足一个完整条目；未读取该部分。');
  if (format !== 'gdt' && Math.floor((limit + 1) / entrySize) > 256)
    warnings.push('x86 中断向量最多 256 项；已限制显示范围。');
  return {
    table: request.table,
    format,
    mode,
    base,
    limit,
    entrySize,
    totalEntries,
    start,
    count,
    entries,
    warnings
  };
}
