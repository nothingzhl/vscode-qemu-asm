import { hex, integer } from '../../application/format';
import { SourceValues } from '../../application/source/values';
import { machineAddress, memoryDataId, watchpoint } from '../../debug/machineBreakpoints';
import { isSafeCExpression } from '../../domain/source/expression';
import type { SourceBackend } from '../../ports/source';
import type { Request, Respond } from './protocol';
export class SourceViewRequests {
  constructor(
    private readonly values: SourceValues,
    private readonly stopped: () => boolean,
    private readonly requireStopped: () => SourceBackend,
    private readonly response: Respond
  ) {}
  async handle(request: Request): Promise<boolean> {
    const args = request.arguments ?? {};
    if (!['stackTrace', 'scopes', 'variables', 'evaluate', 'dataBreakpointInfo'].includes(request.command))
      return false;
    this.stopped();
    switch (request.command) {
      case 'stackTrace': {
        if (!this.stopped()) {
          this.response(request, { stackFrames: [], totalFrames: 0 });
          return true;
        }
        const frames = await this.values.frames(),
          start = Math.max(0, integer(args.startFrame, 0)),
          levels = Math.max(1, Math.min(64, integer(args.levels, 64) || 64));
        this.response(request, {
          stackFrames: frames.slice(start, start + levels),
          totalFrames: frames.length
        });
        return true;
      }
      case 'scopes': {
        if (!this.stopped()) {
          this.response(request, { scopes: [] });
          return true;
        }
        const frame =
          typeof args.frameId === 'number'
            ? this.values.framesById.get(args.frameId)
            : this.values.framesCache?.[0];
        // Expired frame IDs belong to a previous stop. Never resolve them to
        // the new current frame or create handles for delayed native UI reads.
        if (!frame) {
          this.response(request, { scopes: [] });
          return true;
        }
        const scopes = [
          {
            name: '局部变量',
            variablesReference: this.values.handle({ kind: 'locals', frame: frame.level }),
            expensive: false
          },
          {
            name: '参数',
            variablesReference: this.values.handle({ kind: 'arguments', frame: frame.level }),
            expensive: false
          }
        ];
        if (frame.level === 0)
          scopes.push(
            {
              name: '寄存器（当前 CPU）',
              variablesReference: this.values.handle({ kind: 'registers', frame: 0 }),
              expensive: false
            },
            {
              name: '栈内存 SS:SP / SS:ESP',
              variablesReference: this.values.handle({ kind: 'stack', frame: 0 }),
              expensive: false
            },
            {
              name: 'CPU 模式与地址',
              variablesReference: this.values.handle({ kind: 'mode', frame: 0 }),
              expensive: false
            }
          );
        this.response(request, { scopes });
        return true;
      }
      case 'variables':
        this.response(request, {
          variables: this.stopped()
            ? await this.values.variables(
                integer(args.variablesReference, 0),
                Math.max(0, integer(args.start, 0)),
                Math.max(1, Math.min(256, integer(args.count, 256) || 256))
              )
            : []
        });
        return true;
      case 'evaluate': {
        if (!this.stopped()) {
          this.response(request, { result: 'CPU 未暂停；暂停后更新', variablesReference: 0 });
          return true;
        }
        const expression = String(args.expression ?? '').trim();
        if (!isSafeCExpression(expression))
          throw new Error('仅支持只读 C 表达式：变量、成员、指针、下标和算术；不允许赋值、递增或函数调用');
        // Validate an explicit frame before reading GDB: an expired frame must
        // not silently select the current frame or create a new varobj.
        if (typeof args.frameId !== 'number') await this.values.frames();
        const frame = this.values.frame(args.frameId),
          value = await this.values.createVariable(expression, frame.level);
        this.response(request, {
          result: value.value,
          type: value.type,
          variablesReference: value.variablesReference,
          ...(value.memoryReference ? { memoryReference: value.memoryReference } : {}),
          ...(value.indexedVariables === undefined ? {} : { indexedVariables: value.indexedVariables }),
          ...(value.namedVariables === undefined ? {} : { namedVariables: value.namedVariables })
        });
        return true;
      }
      case 'dataBreakpointInfo':
        await this.dataBreakpointInfo(request, args);
        return true;
    }
    return false;
  }
  private async dataBreakpointInfo(request: Request, args: Record<string, unknown>): Promise<void> {
    const runtime = this.requireStopped();
    try {
      let address: number, size: number;
      if (args.memoryReference !== undefined) {
        address = machineAddress(args.memoryReference);
        size = args.bytes === undefined ? 1 : Number(args.bytes);
      } else if (
        typeof args.variablesReference === 'number' &&
        this.values.handles.has(args.variablesReference) &&
        typeof args.name === 'string'
      ) {
        const handle = this.values.handles.get(args.variablesReference)!;
        let expression = args.name;
        if (handle.kind === 'object') {
          const rows = await this.values.variables(args.variablesReference, 0, 256),
            child = rows.find((row) => row.name === args.name);
          if (!child?.evaluateName) throw new Error('无法获取该变量的 C 地址表达式');
          expression = child.evaluateName;
        } else if (handle.kind !== 'locals' && handle.kind !== 'arguments')
          throw new Error('请选择 C 变量或明确的内存地址');
        if (!isSafeCExpression(expression)) throw new Error('变量地址表达式不受支持');
        const location = await runtime.variables.address(expression, handle.frame);
        address = location.address;
        size = location.size;
      } else {
        address = machineAddress(args.name);
        size = args.bytes === undefined ? 1 : Number(args.bytes);
      }
      const point = watchpoint({ address, size, access: 'write' });
      this.response(request, {
        dataId: memoryDataId(point.address, point.size),
        description: `${hex(point.address)} · ${point.size} 字节`,
        accessTypes: ['read', 'write', 'readWrite'],
        canPersist: args.variablesReference === undefined
      });
    } catch (error) {
      this.response(request, {
        dataId: null,
        description: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
