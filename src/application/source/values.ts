import * as path from 'node:path';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
import type { SourceStackReader, SourceVariable, SourceVariableReader } from '../../ports/source';
import { hex, readOnly } from '../format';
import type { Frame, Handle, Variable } from './valuesModel';
import { machineVariables } from './machineValues';

interface ValueBackend extends RegisterReader, MemoryReader {
  variables: SourceVariableReader;
  stack: SourceStackReader;
}

/** Owns frame and variable handles for one C debug session. */
export class SourceValues {
  handles = new Map<number, Handle>();
  framesById = new Map<number, Frame>();
  framesCache?: Frame[];
  handleSerial = 10000;
  private variableObjects = new Set<string>();
  private variableCache = new Map<string, Variable[]>();
  private cachedVariableCount = 0;
  private readonly pendingVariables = new Map<string, Promise<Variable[]>>();
  private pendingFrames?: Promise<Frame[]>;
  private revision = 0;

  handle(value: Handle): number {
    if (this.handles.size >= 4096) throw new Error('当前暂停最多展开 4096 个变量节点，请继续后重试');
    const id = this.handleSerial++;
    this.handles.set(id, value);
    return id;
  }

  frames(): Promise<Frame[]> {
    if (this.framesCache) return Promise.resolve(this.framesCache);
    if (this.pendingFrames) return this.pendingFrames;
    const task = this.loadFrames(this.revision);
    this.pendingFrames = task;
    void task
      .finally(() => {
        if (this.pendingFrames === task) this.pendingFrames = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private async loadFrames(revision: number): Promise<Frame[]> {
    const rows = await this.current().stack.frames();
    this.checkCurrent(revision);
    const frames = rows.map((row) => {
      const frame: Frame = {
        id: this.handleSerial++,
        level: row.level,
        name: row.name,
        line: row.line,
        column: 1,
        ...(row.address === undefined ? {} : { instructionPointerReference: hex(row.address) }),
        ...(row.source ? { source: { name: path.basename(row.source), path: row.source } } : {})
      };
      this.framesById.set(frame.id, frame);
      return frame;
    });
    return (this.framesCache = frames);
  }

  frame(id: unknown): Frame {
    const frame = typeof id === 'number' ? this.framesById.get(id) : this.framesCache?.[0];
    if (!frame) throw new Error('调用栈帧已过期，请在当前暂停后重新选择');
    return frame;
  }

  async expireVariables(): Promise<void> {
    const objects = [...this.variableObjects];
    this.clear();
    const active = this.active();
    if (!active) return;
    await active.variables.release(objects);
  }

  private variable(record: SourceVariable, frame: number, expression?: string, root = false): Variable {
    const object = record.id,
      count = record.childCount;
    // Deleting a root varobj recursively deletes all children. Tracking child
    // names separately would turn one expanded array into hundreds of failing
    // -var-delete requests on every source step.
    if (object && root) this.variableObjects.add(object);
    const value = record.value,
      type = record.type;
    return {
      name: record.name || expression || object,
      value,
      ...(type ? { type } : {}),
      variablesReference:
        count > 0 || record.hasMore ? this.handle({ kind: 'object', frame, object, expression }) : 0,
      ...(count > 0
        ? /\[[^\]]*\]$/.test(type) && !type.includes('*')
          ? { indexedVariables: count }
          : { namedVariables: count }
        : {}),
      ...(expression ? { evaluateName: expression } : {}),
      ...(type.includes('*') && this.parseAddress(value) !== undefined
        ? { memoryReference: hex(this.parseAddress(value)!) }
        : {}),
      presentationHint: readOnly
    };
  }

  async createVariable(expression: string, frame: number): Promise<Variable> {
    if (this.variableObjects.size >= 512) throw new Error('当前暂停最多展开 512 个变量对象，请继续后重试');
    const backend = this.current(),
      revision = this.revision;
    const record = await backend.variables.create(expression, frame);
    if (revision !== this.revision || this.variableObjects.size >= 512) {
      await backend.variables.release([record.id]);
      this.checkCurrent(revision);
      throw new Error('当前暂停最多展开 512 个变量对象，请继续后重试');
    }
    return this.variable(record, frame, expression, true);
  }

  async variables(reference: number, start: number, count: number): Promise<Variable[]> {
    const handle = this.handles.get(reference);
    if (!handle) return [];
    const scope = handle.kind === 'locals' || handle.kind === 'arguments';
    const key = scope ? `${handle.kind}:${handle.frame}` : `${reference}:${start}:${count}`;
    const pending = this.pendingVariables.get(key);
    if (pending) return scope ? (await pending).slice(start, start + count) : pending;
    const task = this.loadVariables(handle, scope ? 0 : start, scope ? 256 : count, this.revision);
    this.pendingVariables.set(key, task);
    void task
      .finally(() => {
        if (this.pendingVariables.get(key) === task) this.pendingVariables.delete(key);
      })
      .catch(() => undefined);
    return scope ? (await task).slice(start, start + count) : task;
  }

  private async loadVariables(
    handle: Handle,
    start: number,
    count: number,
    revision: number
  ): Promise<Variable[]> {
    const runtime = this.current();
    if (handle.kind === 'locals' || handle.kind === 'arguments') {
      const key = `${handle.kind}:${handle.frame}`;
      let variables = this.variableCache.get(key);
      if (!variables) {
        const rows = await runtime.variables.list(handle.frame);
        this.checkCurrent(revision);
        variables = [];
        for (const row of rows
          .filter((row) => row.argument === (handle.kind === 'arguments'))
          .slice(0, 256)) {
          const name = row.name;
          try {
            variables.push({ ...(await this.createVariable(name, handle.frame)), name });
          } catch (error) {
            if (revision !== this.revision) throw error;
            variables.push({
              name,
              value: row.value || `<${error instanceof Error ? error.message : String(error)}>`,
              type: row.type,
              variablesReference: 0,
              evaluateName: name,
              presentationHint: readOnly
            });
          }
        }
        this.checkCurrent(revision);
        this.cacheVariables(key, variables);
      }
      return variables.slice(start, start + count);
    }
    if (handle.kind === 'object') {
      const key = `object:${handle.object}:${start}:${count}`,
        cached = this.variableCache.get(key);
      if (cached) return cached;
      const rows = await runtime.variables.children(handle.object, start, count);
      this.checkCurrent(revision);
      const variables = rows.map((row) => this.variable(row, handle.frame, row.evaluateName));
      this.cacheVariables(key, variables);
      return variables;
    }
    const variables = await machineVariables(runtime, handle.kind, start, count);
    this.checkCurrent(revision);
    return variables;
  }
  constructor(
    private readonly current: () => ValueBackend,
    private readonly active: () => ValueBackend | undefined
  ) {}
  clear(): void {
    this.revision++;
    this.pendingFrames = undefined;
    this.pendingVariables.clear();
    this.handles.clear();
    this.framesById.clear();
    this.framesCache = undefined;
    this.variableCache.clear();
    this.cachedVariableCount = 0;
    this.variableObjects.clear();
  }
  private checkCurrent(revision: number): void {
    if (revision !== this.revision) throw new Error('变量与调用栈已过期，请在当前暂停后重新读取');
  }
  private cacheVariables(key: string, variables: Variable[]): void {
    this.cachedVariableCount -= this.variableCache.get(key)?.length ?? 0;
    this.variableCache.set(key, variables);
    this.cachedVariableCount += variables.length;
    // Array paging must not retain every visited leaf while the guest stays paused.
    while (this.variableCache.size > 128 || this.cachedVariableCount > 4096) {
      const oldest = this.variableCache.keys().next().value!;
      this.cachedVariableCount -= this.variableCache.get(oldest)!.length;
      this.variableCache.delete(oldest);
    }
  }
  private parseAddress(value: string): number | undefined {
    const match = /^(0x[\da-f]+)(?:\s|$)/i.exec(value);
    const at = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(at) && at >= 0 && at <= 0xffffffff ? at : undefined;
  }
}
