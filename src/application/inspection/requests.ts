import { boundedInteger } from '../../domain/validation';
import type { InspectionRuntime } from '../../ports/inspection';
export { boundedInteger } from '../../domain/validation';
export function inspectionAddress(value: number | string): number {
  let address: number;
  if (typeof value === 'number') address = value;
  else if (typeof value === 'string' && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value.trim()))
    address = Number(value.trim());
  else throw new Error('内存地址必须是十进制或 0x 开头的 32 位地址');
  unsigned32(address, '内存地址');
  return address;
}

export function objectArgs(value: unknown): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('检查参数必须是对象');
}
export function unsigned32(value: number, label: string): void {
  boundedInteger(value, 0, 0xffffffff, label);
}
function memoryRange(address: number, count: number): void {
  unsigned32(address, '内存地址');
  if (address + count > 0x100000000) throw new Error('内存读取不能超出 32 位地址范围');
}
export async function readExact(
  runtime: InspectionRuntime,
  address: number,
  count: number,
  space: 'virtual' | 'physical' = 'virtual'
): Promise<Buffer> {
  memoryRange(address, count);
  if (count > 4096) throw new Error('单次检查最多读取 4096 字节');
  const read = space === 'physical' ? runtime.readPhysicalMemory : runtime.readMemory;
  if (typeof read !== 'function') throw new Error('当前调试运行时不支持物理内存读取');
  const bytes = await read.call(runtime, address, count);
  if (!Buffer.isBuffer(bytes) || bytes.length !== count) throw new Error('运行时返回的检查数据不完整');
  return bytes;
}
