import * as path from 'node:path';
import type { DataWatchpoint } from '../../ports/machine';
import type { SourceBreakpointCommands } from '../../ports/source';
import { hex, integer } from '../format';

interface SourceBinding {
  requested: number;
  id: number;
  number: string;
  address?: number;
  line: number;
  source?: string;
}
interface MachineBinding {
  number: string;
  address: number;
  point?: DataWatchpoint;
}

/** Tracks only installed bindings; user intent survives backend restarts elsewhere. */
export class SourceBindings {
  sources = new Map<string, SourceBinding[]>();
  private sourceIds = new Map<string, number>();
  private sourceSerial = 1000000;
  private instructions = new Map<number, MachineBinding>();
  watches = new Map<string, MachineBinding>();
  entry?: { number: string; address?: number };

  constructor(
    private readonly current: () => SourceBreakpointCommands,
    private readonly isCurrent: (commands: SourceBreakpointCommands) => boolean,
    private readonly close: () => Promise<void>
  ) {}

  private sourceId(file: string, line: number): number {
    const key = `${file}:${line}`;
    let id = this.sourceIds.get(key);
    if (!id) {
      id = this.sourceSerial++;
      this.sourceIds.set(key, id);
    }
    return id;
  }

  async replaceSource(file: string, lines: number[]): Promise<Map<number, Record<string, unknown>>> {
    const runtime = this.current(),
      previous = this.sources.get(file) ?? [],
      next: SourceBinding[] = [],
      results = new Map<number, Record<string, unknown>>();
    try {
      for (const line of [...new Set(lines)]) {
        const retained = previous.find((item) => item.requested === line);
        if (retained) {
          next.push(retained);
          results.set(line, this.sourceResult(retained));
          continue;
        }
        try {
          // MI quoting alone does not quote GDB's separate linespec grammar:
          // commas in a valid filename are linespec delimiters. Explicit source
          // and line options pass the filename as data through both parsers.
          const record = await runtime.insertSource(file, line),
            number = record.id;
          if (!number || record.address === undefined || record.pending) {
            if (number) await this.deleteBindings(runtime, [number]);
            throw new Error('GDB 未找到此行的可执行代码');
          }
          const binding: SourceBinding = {
            requested: line,
            id: this.sourceId(file, line),
            number,
            address: record.address,
            line: integer(record.line, line),
            source: record.source || file
          };
          next.push(binding);
          results.set(line, this.sourceResult(binding));
        } catch (error) {
          if (!this.isCurrent(runtime)) throw error;
          results.set(line, {
            verified: false,
            line,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const removed = previous.filter((item) => !next.includes(item));
      await this.deleteBindings(
        runtime,
        removed.map((item) => item.number)
      );
      this.sources.set(file, next);
      return results;
    } catch (error) {
      await this.removeAdded(
        runtime,
        next.filter((item) => !previous.includes(item)).map((item) => item.number)
      );
      throw error;
    }
  }

  private sourceResult(binding: SourceBinding): Record<string, unknown> {
    return {
      id: binding.id,
      verified: true,
      line: binding.line,
      ...(binding.source ? { source: { path: binding.source, name: path.basename(binding.source) } } : {}),
      ...(binding.address === undefined ? {} : { instructionReference: hex(binding.address) })
    };
  }

  async deleteBindings(runtime: SourceBreakpointCommands, numbers: string[]): Promise<void> {
    if (!numbers.length) return;
    try {
      await runtime.remove(numbers);
    } catch (error) {
      // GDB may have applied part of a multi-delete before rejecting it. A
      // failed replacement must never leave a live, incorrectly tracked target.
      await this.close();
      throw new Error(
        `删除断点失败，调试会话已关闭：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async removeAdded(runtime: SourceBreakpointCommands, numbers: string[]): Promise<void> {
    if (!numbers.length) return;
    try {
      await runtime.remove(numbers);
    } catch {
      await this.close();
    }
  }

  async replaceInstructions(addresses: number[]): Promise<void> {
    const runtime = this.current(),
      previous = this.instructions,
      next = new Map<number, MachineBinding>(),
      added: string[] = [];
    try {
      for (const address of addresses) {
        const retained = previous.get(address);
        if (retained) {
          next.set(address, retained);
          continue;
        }
        const result = await runtime.insertInstruction(address),
          number = result.id;
        if (!number) throw new Error('GDB 未确认指令断点');
        added.push(number);
        next.set(address, { number, address });
      }
      const removed = [...previous].filter(([address]) => !next.has(address)).map(([, item]) => item.number);
      await this.deleteBindings(runtime, removed);
      this.instructions = next;
    } catch (error) {
      await this.removeAdded(runtime, added);
      throw error;
    }
  }

  async replaceWatches(points: DataWatchpoint[]): Promise<void> {
    const runtime = this.current(),
      previous = this.watches,
      next = new Map<string, MachineBinding>(),
      added: string[] = [];
    try {
      for (const point of points) {
        const key = `${point.address}:${point.size}:${point.access}`,
          retained = previous.get(key);
        if (retained) {
          next.set(key, retained);
          continue;
        }
        const result = await runtime.insertWatch(point),
          number = result.id;
        if (!number) throw new Error('GDB 未确认数据断点');
        added.push(number);
        next.set(key, { number, address: point.address, point });
      }
      const removed = [...previous].filter(([key]) => !next.has(key)).map(([, item]) => item.number);
      await this.deleteBindings(runtime, removed);
      this.watches = next;
    } catch (error) {
      await this.removeAdded(runtime, added);
      throw error;
    }
  }
  clear(): void {
    this.sources.clear();
    this.instructions.clear();
    this.watches.clear();
    this.entry = undefined;
  }
}
