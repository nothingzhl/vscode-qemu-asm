/** A capability observation belongs to one concrete session and target. */
export type CapabilityState = 'unknown' | 'supported' | 'unsupported';

/** Evidence is deliberately separate from support: a version check is not an integration test. */
export type CapabilityEvidence = 'not-checked' | 'executable' | 'protocol' | 'integration';

export const capabilityIds = [
  'qemu.rspTarget',
  'qemu.segmentRegisters',
  'qemu.physicalMemory',
  'qemu.display',
  'gdb.mi',
  'decoder',
] as const;
export type CapabilityId = typeof capabilityIds[number];

export interface CapabilityScope {
  sessionId: string;
  targetId?: string;
  backend?: string;
  host?: { platform: string; arch: string; release?: string };
  /** Record the actual selected tools and machine options, without sharing global caches. */
  tools?: Record<string, string>;
  machine?: string[];
}

export interface CapabilityUpdate {
  state: CapabilityState;
  evidence: CapabilityEvidence;
  reason: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface CapabilityObservation extends CapabilityUpdate {
  id: CapabilityId;
  observedAt: string;
}

export interface CapabilityReport {
  schemaVersion: 1;
  scope: CapabilityScope;
  createdAt: string;
  updatedAt: string;
  entries: CapabilityObservation[];
}
