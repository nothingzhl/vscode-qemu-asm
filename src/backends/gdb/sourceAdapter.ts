import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type { SourceBackend, SourceFrame, SourceMotion, SourceStoppedEvent } from '../../ports/source';
import type { GdbConnection } from './connection';
import type { MiTuple } from './miParser';
import { GdbSourceBreakpoints } from './sourceBreakpoints';
import { GdbSourceVariables } from './sourceVariables';
import { address, records, text, tuple } from './values';

const motions: Record<SourceMotion, string> = {
  continue: '-exec-continue',
  stepIn: '-exec-step',
  stepOver: '-exec-next',
  stepOut: '-exec-finish',
  instructionIn: '-exec-step-instruction',
  instructionOver: '-exec-next-instruction'
};

/** Translates GDB knowledge into source-debugging capabilities at one boundary. */
export class GdbSourceAdapter extends EventEmitter implements SourceBackend {
  readonly breakpoints: GdbSourceBreakpoints;
  readonly variables: GdbSourceVariables;
  readonly stack = { frames: () => this.frames() };
  readonly execution = {
    execute: async (motion: SourceMotion) => {
      await this.connection.mi(motions[motion]);
    },
    pause: () => this.connection.pause()
  };
  get capabilities() {
    return this.connection.capabilities;
  }

  constructor(
    private readonly connection: GdbConnection,
    private readonly root: string,
    elf?: string
  ) {
    super();
    this.breakpoints = new GdbSourceBreakpoints(connection, elf);
    this.variables = new GdbSourceVariables(connection);
    connection.on('stopped', (event) => this.emit('stopped', this.stopped(event)));
    connection.on('terminated', (result) => this.emit('terminated', result));
  }

  launch() {
    return this.connection.launch();
  }
  dispose() {
    return this.connection.dispose();
  }
  registers() {
    return this.connection.registers();
  }
  readMemory(at: number, count: number) {
    return this.connection.readMemory(at, count);
  }
  readPhysicalMemory(at: number, count: number) {
    return this.connection.readPhysicalMemory(at, count);
  }

  private async frames(): Promise<SourceFrame[]> {
    const reply = await this.connection.mi('-stack-list-frames --thread 1 0 63');
    return records(reply.results.stack, 'frame').map((row) => {
      const line = Number(text(row.line));
      const source =
        Number.isSafeInteger(line) && line > 0
          ? text(row.fullname) || (text(row.file) ? path.resolve(this.root, text(row.file)) : undefined)
          : undefined;
      return {
        level: Number(text(row.level, '0')),
        name: text(row.func, '未知函数'),
        line: source ? line : 1,
        source,
        address: address(row.addr)
      };
    });
  }

  private stopped(event: MiTuple): SourceStoppedEvent {
    const reason = text(event.reason);
    const frame = tuple(event.frame);
    const breakpointId =
      text(event.bkptno) ||
      text(tuple(event.wpt).number) ||
      text(tuple(event['hw-rwpt']).number) ||
      text(tuple(event['hw-awpt']).number) ||
      undefined;
    return {
      reason: /^exited/.test(reason)
        ? 'exit'
        : /watchpoint-trigger/.test(reason)
          ? 'data breakpoint'
          : reason === 'breakpoint-hit'
            ? 'breakpoint'
            : reason === 'entry'
              ? 'entry'
              : reason === 'signal-received'
                ? text(event['signal-name']) === 'SIGINT'
                  ? 'pause'
                  : 'exception'
                : 'step',
      breakpointId,
      functionName: text(frame.func) || undefined,
      line: Number(text(frame.line)) || undefined,
      description: text(event['signal-meaning']) || undefined
    };
  }
}
