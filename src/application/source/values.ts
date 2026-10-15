import * as path from 'node:path';
import { cpuMode, instructionAddress, stackAddress, stackWidth } from '../../domain/x86/state';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
import type { SourceStackReader, SourceVariable, SourceVariableReader } from '../../ports/source';
import { hex, readOnly } from '../format';
import type { Frame, Handle, Variable } from './valuesModel';

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

  handle(value: Handle): number {
    if (this.handles.size >= 4096) throw new Error('当前暂停最多展开 4096 个变量节点，请继续后重试');
    const id = this.handleSerial++;
    this.handles.set(id, value);
    return id;
  }

  async frames(): Promise<Frame[]> {
    if (this.framesCache) return this.framesCache;
    const rows = await this.current().stack.frames();
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
    this.variableObjects.clear();
    this.handles.clear();
    this.framesById.clear();
    this.framesCache = undefined;
    this.variableCache.clear();
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
    const record = await this.current().variables.create(expression, frame);
    return this.variable(record, frame, expression, true);
  }

  async variables(reference: number, start: number, count: number): Promise<Variable[]> {
    const runtime = this.current(),
      handle = this.handles.get(reference);
    if (!handle) return [];
    if (handle.kind === 'locals' || handle.kind === 'arguments') {
      const key = `${handle.kind}:${handle.frame}`;
      let variables = this.variableCache.get(key);
      if (!variables) {
        const rows = await runtime.variables.list(handle.frame);
        variables = [];
        for (const row of rows
          .filter((row) => row.argument === (handle.kind === 'arguments'))
          .slice(0, 256)) {
          const name = row.name;
          try {
            variables.push({ ...(await this.createVariable(name, handle.frame)), name });
          } catch (error) {
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
        this.variableCache.set(key, variables);
      }
      return variables.slice(start, start + count);
    }
    if (handle.kind === 'object') {
      const key = `object:${handle.object}:${start}:${count}`,
        cached = this.variableCache.get(key);
      if (cached) return cached;
      const rows = await runtime.variables.children(handle.object, start, count);
      const variables = rows.map((row) => this.variable(row, handle.frame, row.evaluateName));
      this.variableCache.set(key, variables);
      return variables;
    }
    const r = await runtime.registers();
    if (handle.kind === 'registers')
      return Object.entries(r)
        .slice(start, start + count)
        .map(([name, value]) => ({
          name: name.toUpperCase(),
          value: hex(value),
          type: '寄存器（当前 CPU）',
          variablesReference: 0,
          evaluateName: `$${name}`,
          presentationHint: readOnly
        }));
    if (handle.kind === 'mode')
      return Object.entries({
        MODE: cpuMode(r),
        栈指针位数: String(stackWidth(r) * 8),
        指令线性地址: hex(instructionAddress(r)),
        栈线性地址: hex(stackAddress(r)),
        'CR0.PG': String((r.cr0 ?? 0) >>> 31),
        CR3: hex(r.cr3 ?? 0)
      })
        .slice(start, start + count)
        .map(([name, value]) => ({ name, value, variablesReference: 0, presentationHint: readOnly }));
    const width = cpuMode(r) === 'protected32' ? 4 : 2,
      pointer = stackWidth(r),
      sp = pointer === 4 ? r.esp >>> 0 : r.esp & 0xffff,
      maximum = pointer === 4 ? 0xffffffff : 0xffff;
    const expandDown = cpuMode(r) !== 'real16' && !!((r.ss_flags ?? 0) & (1 << 10)),
      lower = expandDown ? (r.ss_limit ?? maximum) + 1 : 0,
      upper = expandDown ? maximum : Math.min(maximum, r.ss_limit ?? maximum);
    const address = stackAddress(r),
      bytes =
        sp >= lower && sp <= upper
          ? await runtime.readMemory(address, Math.min(16 * width, upper - sp + 1, 0x100000000 - address))
          : Buffer.alloc(0),
      result: Variable[] = [];
    for (let offset = 0; offset + width <= bytes.length; offset += width)
      result.push({
        name: `${hex(r.ss, 4)}:${hex(sp + offset, pointer * 2)}${offset === 0 ? ' ← ESP' : ''}`,
        value: hex(width === 4 ? bytes.readUInt32LE(offset) : bytes.readUInt16LE(offset), width * 2),
        type: `uint${width * 8}`,
        variablesReference: 0,
        memoryReference: hex(address + offset),
        presentationHint: readOnly
      });
    return result.slice(start, start + count);
  }
  constructor(
    private readonly current: () => ValueBackend,
    private readonly active: () => ValueBackend | undefined
  ) {}
  clear(): void {
    this.handles.clear();
    this.framesById.clear();
    this.framesCache = undefined;
    this.variableCache.clear();
    this.variableObjects.clear();
  }
  private parseAddress(value: string): number | undefined {
    const match = /^(0x[\da-f]+)(?:\s|$)/i.exec(value);
    const at = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(at) && at >= 0 && at <= 0xffffffff ? at : undefined;
  }
}
