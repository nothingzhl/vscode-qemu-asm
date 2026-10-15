export interface DebugEndpoint {
  host: string;
  port: number;
}
export interface MachineRun {
  readonly debugEndpoint?: DebugEndpoint;
  readonly executable: string;
  /** Resolves on normal/owned shutdown, rejects on an unexpected process failure. */
  readonly exited: Promise<void>;
}
export interface MachineStartOptions {
  debug?: boolean;
  paused?: boolean;
}
/** Owns only the process it starts. One instance represents one machine lifetime. */
export interface VirtualMachine {
  start(options?: MachineStartOptions): Promise<MachineRun>;
  dispose(): Promise<void>;
}
