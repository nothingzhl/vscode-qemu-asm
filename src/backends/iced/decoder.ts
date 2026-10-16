import type { Decoder, Formatter } from 'iced-x86';
import { InstructionDecoderError, type DecodedInstruction } from '../../ports/instructions';
const ADDRESS_SPACE = 0x100000000;
const MAX_BYTES = 4096;
type DecoderModule = typeof import('iced-x86');
let decoderModule: DecoderModule | undefined;
let decoderFailure: DecoderDependencyError | undefined;

/** Optional decoder failures must not prevent loading the extension or its other features. */
export class DecoderDependencyError extends InstructionDecoderError {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      'iced-x86',
      `x86 解码器不可用（iced-x86）：${reason}。请重新安装完整 VSIX；反汇编及 NASM 无源码映射处的 F10 暂不可用，可用 F11 执行指令单步。`,
      cause
    );
    this.name = 'DecoderDependencyError';
  }
}

function unavailableDecoder(error: unknown): DecoderDependencyError {
  decoderFailure ??= new DecoderDependencyError(error);
  return decoderFailure;
}

function loadDecoder(): DecoderModule {
  if (decoderFailure) throw decoderFailure;
  if (!decoderModule) {
    try {
      // iced-x86 loads its WASM synchronously. Keep that work behind the first
      // actual decoding request instead of making extension activation depend on it.
      const module = require('iced-x86') as DecoderModule;
      if (
        typeof module.Decoder !== 'function' ||
        typeof module.Formatter !== 'function' ||
        !module.DecoderOptions ||
        !module.FormatterSyntax
      )
        throw new Error('解码器模块缺少所需接口');
      decoderModule = module;
    } catch (error) {
      throw unavailableDecoder(error);
    }
  }
  return decoderModule;
}

/** Logical IP is separate from the linear address when CS.base is nonzero. */
export function decodeInstructions(
  bytes: Uint8Array,
  bits: 16 | 32,
  address: number,
  logicalIP = address
): DecodedInstruction[] {
  validAddress(address);
  validAddress(logicalIP);
  if (bits !== 16 && bits !== 32) throw new Error('反汇编仅支持 16 或 32 位指令');
  if (bytes.length > MAX_BYTES || address + bytes.length > ADDRESS_SPACE)
    throw new Error('反汇编字节范围超过 4096 字节或 32 位地址空间');
  if (!bytes.length) return [];
  const iced = loadDecoder();
  let decoder: Decoder | undefined;
  let formatter: Formatter | undefined;
  try {
    decoder = new iced.Decoder(bits, bytes, iced.DecoderOptions.None);
    decoder.ip = BigInt(logicalIP);
    formatter = new iced.Formatter(iced.FormatterSyntax.Nasm);
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
        result.push({
          address: address + position,
          bytes: Buffer.from(bytes.subarray(position, position + size)).toString('hex'),
          text: valid ? formatter.format(instruction) : '无效或不完整的指令',
          size,
          valid
        });
        // An invalid encoding does not establish the next instruction boundary.
        if (!valid) break;
      } finally {
        instruction.free();
      }
    }
    return result;
  } catch (error) {
    throw unavailableDecoder(error);
  } finally {
    formatter?.free();
    decoder?.free();
  }
}

function validAddress(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= ADDRESS_SPACE)
    throw new Error('反汇编地址必须是有效的 32 位无符号整数且不能溢出');
}

export const icedDecoder = { dependency: 'iced-x86', decode: decodeInstructions };
