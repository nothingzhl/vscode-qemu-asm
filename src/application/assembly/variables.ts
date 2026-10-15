import { stackRange } from '../../domain/x86/stack';
import { cpuMode, instructionAddress, stackAddress, stackWidth } from '../../domain/x86/state';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
const hex = (value: number, digits = 4) =>
  `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
export class AssemblyVariables {
  constructor(private readonly requireStopped: () => RegisterReader & MemoryReader) {}
  async variables(reference: number): Promise<unknown[]> {
    const runtime = this.requireStopped();
    const r = await runtime.registers();
    if (reference === 1) {
      const aliases: Record<string, number> = {};
      for (const [short, full] of [
        ['ax', 'eax'],
        ['bx', 'ebx'],
        ['cx', 'ecx'],
        ['dx', 'edx'],
        ['si', 'esi'],
        ['di', 'edi'],
        ['bp', 'ebp'],
        ['sp', 'esp'],
        ['ip', 'eip']
      ])
        aliases[short] = r[full] & 0xffff;
      return Object.entries({ ...aliases, ...r }).map(([name, value]) => ({
        name: name.toUpperCase(),
        value: hex(value, /^(?:e|cr)|_(?:base|limit|flags)$/.test(name) ? 8 : 4),
        type: '寄存器',
        variablesReference: name === 'eflags' ? 4 : 0,
        evaluateName: name,
        presentationHint: { attributes: ['readOnly'] }
      }));
    }
    if (reference === 4)
      return [
        ['CF', 0],
        ['PF', 2],
        ['AF', 4],
        ['ZF', 6],
        ['SF', 7],
        ['TF', 8],
        ['IF', 9],
        ['DF', 10],
        ['OF', 11]
      ].map(([name, bit]) => ({
        name: String(name),
        value: String((r.eflags >>> Number(bit)) & 1),
        variablesReference: 0,
        type: '标志位'
      }));
    if (reference === 2) {
      const width = cpuMode(r) === 'protected32' ? 4 : 2;
      const { pointerBytes: pointer, lower, upper } = stackRange(r);
      const sp = pointer === 4 ? r.esp >>> 0 : r.esp & 0xffff,
        ss = r.ss & 0xffff,
        address = stackAddress(r);
      const bytes =
        sp >= lower && sp <= upper
          ? await runtime.readMemory(address, Math.min(16 * width, upper - sp + 1, 0x100000000 - address))
          : Buffer.alloc(0);
      const variables = [];
      for (let offset = 0; offset + width <= bytes.length; offset += width)
        variables.push({
          name: `${hex(ss)}:${hex(sp + offset, pointer * 2)}${offset === 0 ? (pointer === 4 ? ' ← ESP' : ' ← SP') : ''}`,
          value: hex(width === 4 ? bytes.readUInt32LE(offset) : bytes.readUInt16LE(offset), width * 2),
          type: `uint${width * 8}（小端）`,
          variablesReference: 0,
          memoryReference: hex(address + offset),
          presentationHint: { attributes: ['readOnly'] }
        });
      return variables;
    }
    if (reference === 3)
      return [
        {
          name: '说明',
          value: '调用者来自 BP/EBP 栈帧链，未保存历史寄存器快照；寄存器和栈内存属于当前暂停的 CPU。',
          variablesReference: 0
        }
      ];
    if (reference === 5)
      return Object.entries({
        MODE: cpuMode(r),
        代码位数: cpuMode(r) === 'protected32' ? '32' : '16',
        栈指针位数: String(stackWidth(r) * 8),
        指令线性地址: hex(instructionAddress(r)),
        栈线性地址: hex(stackAddress(r)),
        'CR0.PE': String((r.cr0 ?? 0) & 1),
        'CR0.PG': String((r.cr0 ?? 0) >>> 31),
        'CR0.WP': String(((r.cr0 ?? 0) >>> 16) & 1),
        ...(r.cr3 === undefined ? {} : { CR3: hex(r.cr3, 8) }),
        ...(r.cr4 === undefined
          ? {}
          : { 'CR4.PAE': String((r.cr4 >>> 5) & 1), 'CR4.PSE': String((r.cr4 >>> 4) & 1) })
      }).map(([name, value]) => ({
        name,
        value,
        variablesReference: 0,
        presentationHint: { attributes: ['readOnly'] }
      }));
    return [];
  }
}
