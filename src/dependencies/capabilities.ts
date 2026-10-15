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

function copyScope(scope: CapabilityScope): CapabilityScope {
  return {
    ...scope,
    ...(scope.host ? { host: { ...scope.host } } : {}),
    ...(scope.tools ? { tools: { ...scope.tools } } : {}),
    ...(scope.machine ? { machine: [...scope.machine] } : {}),
  };
}

function copyObservation(observation: CapabilityObservation): CapabilityObservation {
  return { ...observation, ...(observation.details ? { details: { ...observation.details } } : {}) };
}

/** No process-global state: create a fresh ledger after a launch, reconnect or configuration change. */
export class CapabilityLedger {
  private readonly scope: CapabilityScope;
  private readonly createdAt: string;
  private updatedAt: string;
  private readonly entries = new Map<CapabilityId, CapabilityObservation>();

  constructor(scope: CapabilityScope, private readonly now: () => Date = () => new Date()) {
    if (!scope.sessionId.trim()) throw new Error('能力报告必须指定会话标识');
    this.scope = copyScope(scope);
    this.createdAt = this.updatedAt = this.now().toISOString();
    for (const id of capabilityIds) this.entries.set(id, {
      id,
      state: 'unknown',
      evidence: 'not-checked',
      reason: '当前会话尚未检查此能力',
      observedAt: this.createdAt,
    });
  }

  /** Bind actual launched entries before recording protocol evidence, then keep the scope stable. */
  bindTools(tools: Record<string, string>): void {
    if ([...this.entries.values()].some(entry => entry.evidence !== 'not-checked')) {
      throw new Error('已记录能力观察，不能更改会话工具；工具改变后必须创建新的能力报告');
    }
    this.scope.tools = { ...tools };
  }

  record(id: CapabilityId, update: CapabilityUpdate): void {
    if (!this.entries.has(id)) throw new Error(`未知能力：${id}`);
    if (!update.reason.trim()) throw new Error('能力结果必须包含原因');
    this.updatedAt = this.now().toISOString();
    this.entries.set(id, copyObservation({ ...update, id, observedAt: this.updatedAt }));
  }

  snapshot(): CapabilityReport {
    return {
      schemaVersion: 1,
      scope: copyScope(this.scope),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      entries: [...this.entries.values()].map(copyObservation),
    };
  }
}
