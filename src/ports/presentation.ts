import type { CapabilityRecorder } from './machine';
/** Presentation resources owned by one session; backend-specific startup data stays in composition. */
export interface DebugDisplay {
  observeCapabilities?(recorder: CapabilityRecorder): void;
  connect(): Promise<void>;
  dispose(): Promise<void>;
}
