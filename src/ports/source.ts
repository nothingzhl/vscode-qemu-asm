import type {
  CapabilityRecorder,
  CapabilityReporter,
  DataWatchpoint,
  MemoryReader,
  PhysicalMemoryReader,
  RegisterReader,
  SessionLifecycle
} from './machine';

export interface SourceFrame {
  level: number;
  name: string;
  line: number;
  source?: string;
  address?: number;
}
export interface SourceBinding {
  id: string;
  address?: number;
  line?: number;
  source?: string;
  pending: boolean;
}
export type SourceMotion =
  | 'continue'
  | 'stepIn'
  | 'stepOver'
  | 'stepOut'
  | 'instructionIn'
  | 'instructionOver';
export interface SourceExecution {
  execute(motion: SourceMotion): Promise<void>;
  pause(): Promise<void>;
}
export interface SourceStackReader {
  frames(): Promise<SourceFrame[]>;
}
export interface SourceBreakpointCommands {
  insertSource(file: string, line: number): Promise<SourceBinding>;
  insertInstruction(address: number): Promise<SourceBinding>;
  insertEntry(location?: string): Promise<SourceBinding>;
  insertWatch(point: DataWatchpoint): Promise<SourceBinding>;
  remove(ids: string[]): Promise<void>;
}
export interface SourceVariable {
  id: string;
  name: string;
  value: string;
  type: string;
  childCount: number;
  hasMore: boolean;
  evaluateName?: string;
}
export interface NamedSourceVariable {
  name: string;
  value: string;
  type: string;
  argument: boolean;
}
export interface SourceVariableReader {
  list(frame: number): Promise<NamedSourceVariable[]>;
  create(expression: string, frame: number): Promise<SourceVariable>;
  children(id: string, start: number, count: number): Promise<SourceVariable[]>;
  release(ids: string[]): Promise<void>;
  address(expression: string, frame: number): Promise<{ address: number; size: number }>;
}
export interface SourceStoppedEvent {
  reason: 'entry' | 'breakpoint' | 'data breakpoint' | 'step' | 'pause' | 'exception' | 'exit';
  breakpointId?: string;
  functionName?: string;
  line?: number;
  description?: string;
}
/** Composition of capabilities consumed by the current C session, not a universal backend API. */
export interface SourceBackend extends RegisterReader, MemoryReader, PhysicalMemoryReader, SessionLifecycle {
  readonly execution: SourceExecution;
  readonly stack: SourceStackReader;
  readonly variables: SourceVariableReader;
  readonly breakpoints: SourceBreakpointCommands;
  readonly capabilities?: CapabilityReporter & CapabilityRecorder;
  on(event: 'stopped', listener: (event: SourceStoppedEvent) => void): unknown;
  on(event: 'terminated', listener: (result: { error?: string }) => void): unknown;
}
