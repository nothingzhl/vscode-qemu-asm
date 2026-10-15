import { Decoder, DecoderOptions, Formatter, FormatterSyntax } from 'iced-x86';
import { CpuMode, cpuMode, instructionAddress } from './runtime';

const ADDRESS_SPACE = 0x100000000;
const MAX_BYTES = 4096;
const MAX_INSTRUCTIONS = 256;

export interface DecodedInstruction {
  address: number;
  bytes: string;
  text: string;
  size: number;
  valid: boolean;
}

export interface DisassembledInstruction {
  address: string;
  instructionBytes: string;
  instruction: string;
  size: number;
  presentationHint?: 'invalid';
}

export interface DisassemblyResult {
  address: number;
  pc: number;
  mode: CpuMode;
  bits: 16 | 32;
  instructions: DisassembledInstruction[];
  nextAddress: number;
}

export interface DisassemblyRuntime {
  registers(): Promise<Record<string, number>>;
  readMemory(address: number, count: number): Promise<Buffer>;
}

/** Logical IP is separate from the linear address when CS.base is nonzero. */
export function decodeInstructions(bytes: Uint8Array, bits: 16 | 32, address: number, logicalIP = address): DecodedInstruction[] {
  validAddress(address);
  validAddress(logicalIP);
  if (bits !== 16 && bits !== 32) throw new Error('反汇编仅支持 16 或 32 位指令');
  if (bytes.length > MAX_BYTES || address + bytes.length > ADDRESS_SPACE) throw new Error('反汇编字节范围超过 4096 字节或 32 位地址空间');
  const decoder = new Decoder(bits, bytes, DecoderOptions.None);
  let formatter: Formatter | undefined;
  try {
    decoder.ip = BigInt(logicalIP);
    formatter = new Formatter(FormatterSyntax.Nasm);
    formatter.hexPrefix = '0x';
    formatter.hexSuffix = '';
    formatter.uppercaseHex = false;
    formatter.smallHexNumbersInDecimal = false;
    const result: DecodedInstruction[] = [];
    while (decoder.canDecode) {
      const position = decoder.position;
      const instruction = decoder.decode();
      try {
        const size = decoder.position - position;
        if (!size) break;
        const valid = !instruction.isInvalid;
        result.push({ address: address + position, bytes: Buffer.from(bytes.subarray(position, position + size)).toString('hex'),
          text: valid ? formatter.format(instruction) : '无效或不完整的指令', size, valid });
        // An invalid encoding does not establish the next instruction boundary.
        if (!valid) break;
      } finally { instruction.free(); }
    }
    return result;
  } finally { formatter?.free(); decoder.free(); }
}

/** The same bounded implementation serves native DAP and the inspector. */
export async function disassemble(runtime: DisassemblyRuntime, rawArgs: unknown = {}): Promise<DisassemblyResult> {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error('反汇编参数必须是对象');
  const args = rawArgs as Record<string, unknown>;
  const count = integer(args.instructionCount ?? args.count ?? 64, 1, MAX_INSTRUCTIONS, '指令数量');
  const byteOffset = integer(args.offset ?? 0, -0xffffffff, 0xffffffff, '字节偏移');
  const instructionOffset = integer(args.instructionOffset ?? 0, -MAX_INSTRUCTIONS, MAX_INSTRUCTIONS, '指令偏移');
  if (args.bits !== undefined) throw new Error('指令位宽由当前 CPU 的 CS 缓存决定，不能手动覆盖');
  const registers = await runtime.registers();
  const mode = cpuMode(registers);
  const bits = mode === 'protected32' ? 32 : 16;
  const pc = instructionAddress(registers);
  const reference = args.memoryReference ?? args.address ?? pc;
  const address = parseAddress(reference) + byteOffset;
  validAddress(address);
  const base = registers.cs_base ?? ((registers.cs & 0xffff) * 16);
  const limit = registers.cs_limit ?? 0xffff;
  validAddress(base);
  validAddress(limit);
  const logicalIP = (address - base + ADDRESS_SPACE) % ADDRESS_SPACE;
  if (logicalIP > limit) throw new Error('反汇编地址必须位于当前 CS 代码段内');
  // Segment translation is architectural modulo 2^32, but a single memory
  // read must stop before either the linear or logical address wraps.
  const end = address + Math.min(ADDRESS_SPACE - address, limit - logicalIP + 1);

  const unknown = (at: number, message: string): DisassembledInstruction => ({
    address: hexAddress(at), instructionBytes: '', instruction: message, size: 0, presentationHint: 'invalid'
  });
  const asDap = (item: DecodedInstruction): DisassembledInstruction => ({
    address: hexAddress(item.address), instructionBytes: item.bytes, instruction: item.text, size: item.size,
    ...(item.valid ? {} : { presentationHint: 'invalid' as const })
  });
  const requested = Math.min(MAX_BYTES, (Math.max(0, instructionOffset) + count) * 15, end - address);
  let decoded = decodeInstructions(await readablePrefix(runtime, address, requested), bits, address, logicalIP);
  let items: DisassembledInstruction[];
  if (instructionOffset < 0) {
    const preceding = -instructionOffset;
    // The stopped PC provides a real boundary. Arbitrary reverse decoding would
    // guess on variable-length x86 instructions, so only use a verified chain.
    let prefix: DecodedInstruction[] = [];
    const pcOffset = (pc - base + ADDRESS_SPACE) % ADDRESS_SPACE;
    if (pc < address && address - pc <= MAX_BYTES && pcOffset + address - pc <= limit) {
      const bytes = await readablePrefix(runtime, pc, address - pc);
      const chain = decodeInstructions(bytes, bits, pc, pcOffset);
      if (chain.length && chain.every(item => item.valid) && chain.at(-1)!.address + chain.at(-1)!.size === address) prefix = chain.slice(-preceding);
    }
    const missing = preceding - prefix.length;
    const unknownEnd = prefix[0]?.address ?? address;
    items = Array.from({ length: Math.min(missing, count) }, (_, index) =>
      unknown(Math.max(0, address - logicalIP, unknownEnd - missing + index), '未知前驱指令边界；从参考地址向前滚动以建立边界'));
    items.push(...prefix.slice(0, count - items.length).map(asDap));
    items.push(...decoded.slice(0, count - items.length).map(asDap));
  } else {
    decoded = decoded.slice(instructionOffset);
    items = decoded.slice(0, count).map(asDap);
  }
  const last = items.filter(item => item.size > 0).at(-1);
  // An exclusive end of 2^32 is a sentinel; callers must disable forward
  // navigation there rather than wrapping back to address zero.
  const nextAddress = last ? parseAddress(last.address) + last.size : address;
  while (items.length < count) items.push(unknown(Math.min(end - 1, nextAddress), '无法读取或确定后续指令边界'));
  return { address, pc, mode, bits, instructions: items, nextAddress };
}

/** Probe a smaller prefix on an unmapped tail, with at most 13 bounded reads. */
async function readablePrefix(runtime: DisassemblyRuntime, address: number, size: number): Promise<Buffer> {
  let low = 0;
  let high = size + 1;
  let bytes: Buffer = Buffer.alloc(0);
  let probe = size;
  while (low + 1 < high) {
    try {
      const candidate = await runtime.readMemory(address, probe);
      if (candidate.length !== probe) throw new Error('QEMU 返回不完整的指令字节');
      bytes = candidate;
      low = probe;
    } catch { high = probe; }
    probe = Math.floor((low + high) / 2);
  }
  return bytes;
}

function validAddress(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= ADDRESS_SPACE) throw new Error('反汇编地址必须是有效的 32 位无符号整数且不能溢出');
}

function parseAddress(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? Number(value) : NaN;
  validAddress(result);
  return result;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}

function hexAddress(value: number): string { return `0x${value.toString(16).padStart(8, '0')}`; }
