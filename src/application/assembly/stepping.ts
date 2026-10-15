import { cpuMode, instructionAddress } from '../../domain/x86/state';
import type { InstructionDecoder } from '../../ports/instructions';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
import { disassemble } from '../disassembly';
import type { LocateLive } from './frames';
/** A verified CALL boundary provides a temporary breakpoint target for F10. */
export async function nextCallTarget(
  runtime: MemoryReader & RegisterReader,
  locate: LocateLive,
  decoder: InstructionDecoder
): Promise<number | undefined> {
  const registers = await runtime.registers();
  const address = instructionAddress(registers);
  const mapped = (await locate(address, cpuMode(registers) === 'protected32' ? 32 : 16, registers))?.entry;
  const decoded = mapped
    ? undefined
    : (await disassemble(runtime, { address, count: 1 }, decoder)).instructions[0];
  const entry =
    mapped ??
    (decoded && decoded.presentationHint !== 'invalid' && decoded.size > 0
      ? { address, size: decoded.size }
      : undefined);
  const bytes = await runtime.readMemory(address, entry?.size ?? 1);
  let opcode = 0;
  while (
    [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3].includes(bytes[opcode]) &&
    opcode < bytes.length - 1
  )
    opcode++;
  const call =
    [0xe8, 0x9a, 0xcd].includes(bytes[opcode]) ||
    (bytes[opcode] === 0xff && [2, 3].includes((bytes[opcode + 1] >> 3) & 7));

  return entry && call ? entry.address + entry.size : undefined;
}
