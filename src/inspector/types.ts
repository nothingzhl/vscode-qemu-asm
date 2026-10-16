/** Guest snapshots and breakpoint changes only operate at confirmed stops; memory is never persisted. */
export type InspectorTab = 'memory' | 'gdt' | 'idt' | 'disassembly' | 'watchpoints' | 'paging';
export type MemoryFollow = 'address' | 'esp' | 'ebp';
export interface InspectorSession {
  readonly id: string;
  customRequest(command: string, args: unknown): PromiseLike<unknown>;
}
export type MemorySpace = 'virtual' | 'physical';
export interface InspectorForm {
  tab: InspectorTab;
  address: number;
  follow: MemoryFollow;
  memorySpace: MemorySpace;
  pagingAddress: number;
  gdtStart: number;
  idtStart: number;
  disassemblyAddress: number;
  disassemblyFollow: boolean;
}
export interface MemoryData {
  address: number;
  count: number;
  bytes: number[];
  mode: string;
  follow: MemoryFollow;
  space: MemorySpace;
  addressContext: string;
  pagingEnabled: boolean;
  cr3?: number;
  cr4?: number;
  pageMappings: { virtualPage: number; physicalPage: number }[];
  changed: boolean[];
}
export interface DescriptorEntry {
  index: number;
  address: number;
  raw: string;
  kind: string;
  type: string;
  present: boolean;
  dpl: number;
  valid: boolean;
  warnings: string[];
  selector?: number;
  targetSelector?: number;
  parameterCount?: number;
  base?: number;
  effectiveLimit?: number;
  granularity?: boolean;
  defaultBits?: number;
  registers?: string[];
  cacheWarnings?: string[];
  offset?: number;
  gateBits?: number;
  readable?: boolean;
  writable?: boolean;
  conforming?: boolean;
  expandDown?: boolean;
  accessed?: boolean;
}
export interface DescriptorData {
  table: 'gdt' | 'idt';
  format: string;
  mode: string;
  base: number;
  limit: number;
  entrySize: number;
  totalEntries: number;
  start: number;
  count: number;
  entries: DescriptorEntry[];
  warnings: string[];
}
export interface DisassemblyInstruction {
  address: string;
  instructionBytes: string;
  instruction: string;
  size: number;
  presentationHint?: 'normal' | 'invalid';
}
export interface DisassemblyData {
  address: number;
  pc: number;
  mode: string;
  bits: 16 | 32;
  instructions: DisassemblyInstruction[];
  nextAddress: number;
}
export type BreakpointOrigin = 'native' | 'custom' | 'both';
export interface InstructionBreakpoint {
  address: number;
  verified: boolean;
  id?: number;
  message?: string;
  origin: BreakpointOrigin;
}
export type WatchAccess = 'write' | 'read' | 'readWrite';
export interface Watchpoint {
  id: number;
  dataId: string;
  address: number;
  size: 1 | 2 | 4;
  access: WatchAccess;
  verified: boolean;
  message?: string;
  origin: BreakpointOrigin;
}
export interface WatchpointData {
  breakpoints: Watchpoint[];
  warnings?: string[];
  lastHit?: { address: number; access: WatchAccess; ids: number[]; pc: number };
}
export interface PageEntry {
  level: 'directory' | 'table';
  index: number;
  address: number;
  raw: number;
  present: boolean;
  writable: boolean;
  user: boolean;
  writeThrough: boolean;
  cacheDisable: boolean;
  accessed: boolean;
  dirty?: boolean;
  pageSize?: boolean;
  global?: boolean;
  pat?: boolean;
  base?: number;
  reservedBits?: number;
}
export interface PagingData {
  address: number;
  mode: string;
  pagingEnabled: boolean;
  format: 'disabled' | 'legacy32';
  cr0: number;
  cr3?: number;
  cr4?: number;
  wp: boolean;
  pse: boolean;
  directoryBase?: number;
  directoryIndex: number;
  tableIndex: number;
  offset: number;
  status: 'identity' | 'mapped' | 'not-present' | 'invalid' | 'unsupported';
  physicalAddress?: number;
  pageSize?: 4096 | 4194304;
  faultLevel?: 'directory' | 'table';
  pde?: PageEntry;
  pte?: PageEntry;
  effective?: {
    user: boolean;
    writable: boolean;
    supervisorRead: boolean;
    supervisorWrite: boolean;
    userRead: boolean;
    userWrite: boolean;
  };
  warnings: string[];
  explanation: string;
}
export interface InspectorSnapshot {
  generation: number;
  sessionId?: string;
  form: InspectorForm;
  status: 'idle' | 'running' | 'stopped';
  busy: boolean;
  stale: boolean;
  message: string;
  memory?: MemoryData;
  gdt?: DescriptorData;
  idt?: DescriptorData;
  disassembly?: DisassemblyData;
  instructionBreakpoints?: InstructionBreakpoint[];
  watchpoints?: WatchpointData;
  paging?: PagingData;
}
