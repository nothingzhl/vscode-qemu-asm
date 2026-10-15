import type { CapabilityReport, CapabilityUpdate, CapabilityId } from '../domain/capabilities';

export type Registers = Record<string, number>;
export interface RegisterReader { registers(): Promise<Registers> }
/** Reads the current virtual/linear address space; CPU must be stopped. */
export interface MemoryReader { readMemory(address: number, count: number): Promise<Buffer> }
/** Optional, distinct from virtual memory; implementations must restore address mode. */
export interface PhysicalMemoryReader { readPhysicalMemory(address: number, count: number): Promise<Buffer> }
export interface ExecutionControl { resume(step?: boolean): Promise<void>; pause(): Promise<void> }
export interface SessionLifecycle { launch(): Promise<void>; dispose(): Promise<void> }
export interface CapabilityReporter { snapshot(): CapabilityReport }
export interface CapabilityRecorder { record(id: CapabilityId, update: CapabilityUpdate): void }
export type WatchAccess = 'read' | 'write' | 'readWrite';
export interface DataWatchpoint { address: number; size: 1 | 2 | 4; access: WatchAccess }
export interface AddressBreakpoints { setBreakpoints(addresses: number[]): Promise<void> }
export interface DataBreakpoints { setDataBreakpoints(points: DataWatchpoint[]): Promise<void> }
export interface StoppedEvent {
  reason: 'entry' | 'breakpoint' | 'data breakpoint' | 'step' | 'pause' | 'exception';
  signal?: number;
  dataAddress?: number;
  dataAccess?: WatchAccess;
}
export interface BackendEvents {
  on(event: 'stopped', listener: (event: StoppedEvent) => void): unknown;
  on(event: 'terminated', listener: (result: { error?: string }) => void): unknown;
}
/** This consumer needs existing assembly capabilities, not every future backend feature. */
export interface AssemblyBackend extends RegisterReader, MemoryReader, PhysicalMemoryReader,
  ExecutionControl, SessionLifecycle, AddressBreakpoints, DataBreakpoints, BackendEvents {
  readonly capabilities: CapabilityReporter & CapabilityRecorder;
}
