import * as path from 'node:path';
import type { SourceEntry, SourceMap } from '../../domain/source/map';
import { stackRange } from '../../domain/x86/stack';
import { cpuMode, instructionAddress, stackAddress } from '../../domain/x86/state';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
const hex = (value: number) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(4, '0')}`;
export interface Frame {
  id: number;
  name: string;
  line: number;
  column: number;
  instructionPointerReference: string;
  source?: { name: string; path: string };
}
export type LocateLive = (
  address: number,
  bits: 16 | 32,
  registers: Record<string, number>
) => Promise<{ map: SourceMap; entry: SourceEntry } | undefined>;
export class AssemblyFrames {
  constructor(
    private readonly requireStopped: () => RegisterReader & MemoryReader,
    private readonly locateLive: LocateLive
  ) {}
  async frames(): Promise<Frame[]> {
    const runtime = this.requireStopped();
    const registers = await runtime.registers();
    const bits = cpuMode(registers) === 'protected32' ? 32 : 16;
    const word = bits / 8;
    const { pointerBytes, lower, upper } = stackRange(registers);
    const maxSlot = upper - word * 2 + 1;
    const frames: Frame[] = [];
    const add = async (address: number, name: string) => {
      const located = await this.locateLive(address, bits, registers);
      frames.push({
        id: frames.length + 1,
        name: `${name} ${hex(address)}`,
        line: located?.entry.line ?? 1,
        column: 1,
        instructionPointerReference: hex(address),
        ...(located
          ? { source: { name: path.basename(located.map.sourcePath), path: located.map.sourcePath } }
          : {})
      });
    };
    await add(instructionAddress(registers), '当前指令');
    let bp = pointerBytes === 4 ? registers.ebp >>> 0 : registers.ebp & 0xffff;
    const sp = pointerBytes === 4 ? registers.esp >>> 0 : registers.esp & 0xffff;
    for (
      let count = 0;
      count < 15 && sp >= lower && bp >= sp && bp >= lower && bp > 0 && bp <= maxSlot;
      count++
    ) {
      const address = stackAddress(registers, bp);
      if (address + word * 2 > 0x100000000) break;
      const words = await runtime.readMemory(address, word * 2);
      const previous = word === 4 ? words.readUInt32LE(0) : words.readUInt16LE(0);
      const returnOffset = word === 4 ? words.readUInt32LE(word) : words.readUInt16LE(word);
      const returnAddress = ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + returnOffset) >>> 0;
      const located = await this.locateLive(returnAddress, bits, registers);
      if (
        !located ||
        located.entry.address !== returnAddress ||
        (previous !== 0 && (previous <= bp || previous < lower || previous > maxSlot))
      )
        break;
      const call = located.map.entries.find(
        (entry) => entry.address + entry.size === returnAddress && (entry.bits ?? 16) === bits
      );
      if (!call) break;
      if (!(await this.locateLive(call.address, bits, registers))) break;
      const opcode = await runtime.readMemory(call.address, Math.min(call.size, 2));
      if (opcode[0] !== 0xe8 && !(opcode[0] === 0xff && ((opcode[1] >> 3) & 7) === 2)) break;
      await add(returnAddress, bits === 32 ? '调用者（EBP 链）' : '调用者（BP 链）');
      if (previous === 0) break;
      bp = previous;
    }
    return frames;
  }
}
