import type { CpuMode } from '../domain/x86/state';
import type { CapabilityRecorder, MemoryReader, RegisterReader } from './machine';
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

export interface DisassemblyRuntime extends RegisterReader, MemoryReader {
  /** Optional for standalone consumers; real adapters record into their session ledger. */
  capabilities?: CapabilityRecorder;
}

/** Decoder implementations own their native resources; results contain no library objects. */
export interface InstructionDecoder {
  readonly dependency: string;
  decode(bytes: Uint8Array, bits: 16 | 32, address: number, logicalIP?: number): DecodedInstruction[];
}

export class InstructionDecoderError extends Error {
  constructor(
    readonly dependency: string,
    message: string,
    cause: unknown
  ) {
    super(message, { cause });
  }
}
