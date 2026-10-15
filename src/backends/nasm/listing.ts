import { SourceMap, type SourceEntry } from '../../domain/source/map';
import { fail, inspectSource } from './sourceSyntax';
export { SourceMap, type SourceEntry } from '../../domain/source/map';
function listingSize(field: string, line: number): number {
  let value = field.trim().replace(/-$/, '');
  const reserved = /^<res ([0-9a-f]+)h>$/i.exec(value);
  if (reserved) return Number.parseInt(reserved[1], 16);
  let repeat = 1;
  const repeated = /<rep ([0-9a-f]+)h>$/i.exec(value);
  if (repeated) {
    repeat = Number.parseInt(repeated[1], 16);
    value = value.slice(0, repeated.index);
  }
  value = value.replace(/[\[\]()]/g, '');
  if (!/^(?:[0-9a-f]{2}|\?\?)+$/i.test(value)) fail('无法识别 NASM listing 机器码字段', line);
  const size = (value.length / 2) * repeat;
  if (!Number.isSafeInteger(size) || size <= 0) fail('listing 机器码长度无效', line);
  return size;
}

/**
 * Parse an actual NASM `-f bin -l` listing, retaining each instruction's effective
 * 16/32-bit mode. Every stage is a fixed-address flat binary: sections, includes
 * and macro expansion are rejected instead of inventing relocated mappings.
 */
export function parseListing(
  listing: string,
  sourcePath: string,
  sourceText: string,
  options: { loadAddress?: number; maxBytes?: number; initialBits?: 16 | 32 | 'auto' } = {}
): SourceMap {
  const loadAddress = options.loadAddress ?? 0x7c00;
  const maxBytes = options.maxBytes ?? 512;
  const initialBits = options.initialBits ?? 16;
  if (!Number.isSafeInteger(loadAddress) || loadAddress < 0 || loadAddress > 0xffffffff)
    fail('加载地址必须是 32 位无符号整数');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 0x100000000)
    fail('镜像长度上限必须是有效的 32 位地址跨度');
  if (initialBits !== 16 && initialBits !== 32 && initialBits !== 'auto')
    fail('初始代码模式必须是 BITS 16、BITS 32 或 auto');
  const lines = sourceText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  if (lines.at(-1) === '') lines.pop();
  const { kinds, origin, modes } = inspectSource(lines, loadAddress, initialBits);
  const seenSource = new Set<number>();
  const entries = new Map<number, SourceEntry>();
  let previousEnd = 0;
  for (const row of listing.replace(/\r\n/g, '\n').split('\n')) {
    if (!row.trim()) continue;
    // NASM's standard listing has a six-column line number and source at col 41.
    if (!/^\s*\d+ /.test(row.slice(0, 7))) fail('无法识别 listing 行号或格式');
    const line = Number(row.slice(0, 6).trim());
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) fail('listing 行号不在当前源文件中');
    const offsetText = row.slice(7, 15).trim();
    const field = row.slice(16, 40).trim();
    if (!offsetText && /^\*+$/.test(field)) continue; // A NASM warning, not a source/byte row.
    const original = row.slice(40).trimEnd();
    if (original || !seenSource.has(line)) {
      if (original !== lines[line - 1].trimEnd()) fail('listing 与当前源文件内容不同，请重新构建', line);
      seenSource.add(line);
    }
    if (!offsetText) {
      if (field) fail('首版调试不支持宏展开或额外 listing 字段', line);
      continue;
    }
    if (!/^[0-9a-f]{8}$/i.test(offsetText)) fail('无法识别 listing 文件偏移', line);
    const offset = Number.parseInt(offsetText, 16);
    const size = listingSize(field, line);
    if (offset !== previousEnd) fail('listing 地址重复或不连续，无法可靠映射', line);
    previousEnd = offset + size;
    if (!Number.isSafeInteger(previousEnd) || previousEnd > maxBytes)
      fail(`镜像超出配置的 ${maxBytes} 字节长度上限`, line);
    if (origin + previousEnd > 0x100000000) fail('镜像超出 32 位地址范围', line);
    if (kinds[line - 1] === 'other') fail('非指令语句产生了机器码，首版无法可靠映射', line);
    if (kinds[line - 1] !== 'instruction') continue;
    const existing = entries.get(line);
    if (existing) {
      if (existing.address + existing.size !== origin + offset) fail('同一源码行的机器码不连续', line);
      entries.set(line, { ...existing, size: existing.size + size });
    } else
      entries.set(line, {
        line,
        address: origin + offset,
        size,
        text: lines[line - 1],
        bits: modes[line - 1]
      });
    if ((entries.get(line)?.size ?? 0) > 15) fail('一行对应超过一条 x86 指令，不能设置可靠断点', line);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!seenSource.has(i + 1)) fail('listing 缺少当前源码行，请重新构建', i + 1);
    if (kinds[i] === 'instruction' && !entries.has(i + 1)) fail('指令缺少机器码，无法可靠映射', i + 1);
  }
  if (!entries.size) fail('源文件中没有可调试指令');
  return new SourceMap(sourcePath, origin, [...entries.values()], previousEnd);
}
