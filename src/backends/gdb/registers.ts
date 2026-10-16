import { cpuMode } from '../../domain/x86/state';
import type { CapabilityRecorder } from '../../ports/machine';
import { monitorRegisters } from '../qemu/monitor';
import { miQuote, type MiRecord } from './miParser';
import { tuple } from './values';
export async function readGdbRegisters(
  execute: (command: string) => Promise<MiRecord>,
  registerNames: readonly string[],
  capabilities: CapabilityRecorder,
  quietly: (execute: (command: string) => Promise<MiRecord>, command: string) => Promise<MiRecord>
): Promise<Record<string, number>> {
  const values = (await execute('-data-list-register-values x')).results['register-values'];
  if (!Array.isArray(values)) throw new Error('GDB 返回无效寄存器数据');
  const registers: Record<string, number> = {};
  for (const raw of values) {
    const row = tuple(raw);
    if (
      !row ||
      typeof row.number !== 'string' ||
      typeof row.value !== 'string' ||
      !/^0x[\da-f]+$/i.test(row.value)
    )
      continue;
    const name = registerNames[Number(row.number)];
    const value = Number(row.value);
    if (name && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) registers[name] = value;
  }
  for (const name of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags']) {
    if (registers[name] === undefined) throw new Error(`GDB 无法读取 ${name} 寄存器`);
  }
  const monitor = await quietly(execute, `-interpreter-exec console ${miQuote('monitor info registers')}`);
  try {
    Object.assign(registers, monitorRegisters(monitor.console ?? ''));
    const mode = cpuMode(registers);
    capabilities.record('qemu.segmentRegisters', {
      state: 'supported',
      evidence: 'protocol',
      reason: '当前 GDB MI monitor 的 CR0 与段缓存已解析并通过 CPU 模式校验',
      details: { mode }
    });
  } catch (error) {
    capabilities.record('qemu.segmentRegisters', {
      state: 'unsupported',
      evidence: 'protocol',
      reason: (error as Error).message
    });
    throw error;
  }
  return registers;
}
