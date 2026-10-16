import { stackRange } from '../../domain/x86/stack';
import { cpuMode, instructionAddress, stackAddress, stackWidth } from '../../domain/x86/state';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
import { hex, readOnly } from '../format';
import type { Handle, Variable } from './valuesModel';

/** Machine scopes describe the paused CPU, independently of the selected C frame. */
export async function machineVariables(
  runtime: RegisterReader & MemoryReader,
  kind: Handle['kind'],
  start: number,
  count: number
): Promise<Variable[]> {
  const r = await runtime.registers();
  if (kind === 'registers')
    return Object.entries(r)
      .slice(start, start + count)
      .map(([name, value]) => ({
        name: name.toUpperCase(),
        value: hex(value),
        type: '寄存器（当前 CPU）',
        variablesReference: 0,
        evaluateName: `$${name}`,
        presentationHint: readOnly
      }));
  if (kind === 'mode')
    return Object.entries({
      MODE: cpuMode(r),
      栈指针位数: String(stackWidth(r) * 8),
      指令线性地址: hex(instructionAddress(r)),
      栈线性地址: hex(stackAddress(r)),
      'CR0.PG': String((r.cr0 ?? 0) >>> 31),
      CR3: hex(r.cr3 ?? 0)
    })
      .slice(start, start + count)
      .map(([name, value]) => ({ name, value, variablesReference: 0, presentationHint: readOnly }));
  const width = cpuMode(r) === 'protected32' ? 4 : 2;
  const { pointerBytes: pointer, lower, upper } = stackRange(r);
  const sp = pointer === 4 ? r.esp >>> 0 : r.esp & 0xffff;
  const address = stackAddress(r);
  const bytes =
    sp >= lower && sp <= upper
      ? await runtime.readMemory(address, Math.min(16 * width, upper - sp + 1, 0x100000000 - address))
      : Buffer.alloc(0);
  const result: Variable[] = [];
  for (let offset = 0; offset + width <= bytes.length; offset += width)
    result.push({
      name: `${hex(r.ss, 4)}:${hex(sp + offset, pointer * 2)}${offset === 0 ? ' ← ESP' : ''}`,
      value: hex(width === 4 ? bytes.readUInt32LE(offset) : bytes.readUInt16LE(offset), width * 2),
      type: `uint${width * 8}`,
      variablesReference: 0,
      memoryReference: hex(address + offset),
      presentationHint: readOnly
    });
  return result.slice(start, start + count);
}
