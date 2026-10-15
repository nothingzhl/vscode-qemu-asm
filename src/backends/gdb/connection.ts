import type {
  CapabilityRecorder,
  CapabilityReporter,
  MemoryReader,
  PhysicalMemoryReader,
  RegisterReader,
  SessionLifecycle
} from '../../ports/machine';
import type { MiRecord, MiTuple } from './miParser';

/** Private GDB integration seam. No application contract imports MI types. */
export interface GdbConnection extends RegisterReader, MemoryReader, PhysicalMemoryReader, SessionLifecycle {
  readonly capabilities?: CapabilityReporter & CapabilityRecorder;
  mi(command: string): Promise<MiRecord>;
  pause(): Promise<void>;
  on(event: 'stopped', listener: (event: MiTuple) => void): unknown;
  on(event: 'terminated', listener: (result: { error?: string }) => void): unknown;
}
