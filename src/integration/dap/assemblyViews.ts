import { AssemblyFrames } from '../../application/assembly/frames';
import { AssemblyVariables } from '../../application/assembly/variables';
import { hex, integer } from '../../application/format';
import { machineAddress, memoryDataId, watchpoint } from '../../application/machine/breakpoints';
import { cpuMode, instructionAddress, stackAddress } from '../../domain/x86/state';
import type { MemoryReader, RegisterReader } from '../../ports/machine';
import type { Request, Respond } from './protocol';
export class AssemblyViewRequests {
  constructor(
    private readonly framesView: AssemblyFrames,
    private readonly variablesView: AssemblyVariables,
    private readonly stopped: () => boolean,
    private readonly requireStopped: () => RegisterReader & MemoryReader,
    private readonly response: Respond
  ) {}
  private address(text: string): number {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error('内存地址必须为十进制或 0x 十六进制');
    return Number(text);
  }
  async handle(request: Request): Promise<boolean> {
    const args = request.arguments ?? {};
    if (!['stackTrace', 'scopes', 'variables', 'evaluate', 'dataBreakpointInfo'].includes(request.command))
      return false;
    this.stopped();
    switch (request.command) {
      case 'stackTrace': {
        // VS Code can queue a previous stop's stack refresh behind continue or
        // restart. The old frames have expired; never read a running CPU for it.

        if (!this.stopped()) {
          this.response(request, { stackFrames: [], totalFrames: 0 });
          return true;
        }
        const all = await this.framesView.frames(),
          start = Math.max(0, integer(args.startFrame, 0)),
          levels = integer(args.levels, all.length) || all.length;
        this.response(request, { stackFrames: all.slice(start, start + levels), totalFrames: all.length });
        return true;
      }
      case 'scopes':
        if (!this.stopped()) {
          this.response(request, { scopes: [] });
          return true;
        }
        this.response(request, {
          scopes:
            integer(args.frameId, 1) === 1
              ? [
                  { name: '寄存器', variablesReference: 1, expensive: false },
                  { name: '栈内存 SS:SP / SS:ESP', variablesReference: 2, expensive: false },
                  { name: 'CPU 模式与地址', variablesReference: 5, expensive: false }
                ]
              : [{ name: '调用者信息', variablesReference: 3, expensive: false }]
        });
        return true;
      case 'variables':
        this.response(request, {
          variables: this.stopped()
            ? await this.variablesView.variables(integer(args.variablesReference, 0))
            : []
        });
        return true;
      case 'evaluate': {
        if (!this.stopped()) {
          this.response(request, { result: 'CPU 未暂停；暂停后更新', variablesReference: 0 });
          return true;
        }
        if (integer(args.frameId, 1) !== 1)
          throw new Error('调用者没有历史寄存器快照，请选择当前指令栈帧查看');
        const runtime = this.requireStopped();
        const r = await runtime.registers();
        const expression = String(args.expression ?? '')
          .trim()
          .replace(/^\$/, '')
          .toLowerCase();
        let value: number;
        const aliases: Record<string, string> = {
          ax: 'eax',
          bx: 'ebx',
          cx: 'ecx',
          dx: 'edx',
          si: 'esi',
          di: 'edi',
          bp: 'ebp',
          sp: 'esp',
          ip: 'eip',
          flags: 'eflags'
        };
        if (expression === 'mode') {
          this.response(request, { result: cpuMode(r), variablesReference: 0 });
          return true;
        }
        if (expression === 'cs:ip' || expression === 'cs:eip') value = instructionAddress(r);
        else if (expression === 'ss:sp' || expression === 'ss:esp') value = stackAddress(r);
        else if (/^dword\[(?:0x[0-9a-f]+|\d+)\]$/.test(expression))
          value = (await runtime.readMemory(this.address(expression.slice(6, -1)), 4)).readUInt32LE(0);
        else if (/^\[(?:0x[0-9a-f]+|\d+)\]$/.test(expression))
          value = (await runtime.readMemory(this.address(expression.slice(1, -1)), 2)).readUInt16LE(0);
        else if (expression in aliases) value = r[aliases[expression]] & 0xffff;
        else if (Object.prototype.hasOwnProperty.call(r, expression)) value = r[expression];
        else
          throw new Error(
            '可查看寄存器、MODE、CS:EIP、SS:ESP、[0x地址] 的 16 位值或 dword[0x地址] 的 32 位值'
          );
        this.response(request, {
          result: hex(value),
          variablesReference: 0,
          memoryReference: ['ss:sp', 'ss:esp', 'cs:ip', 'cs:eip'].includes(expression)
            ? hex(value)
            : undefined
        });
        return true;
      }
      case 'dataBreakpointInfo': {
        const runtime = this.requireStopped();
        let address: number, size: number;
        try {
          if (args.memoryReference !== undefined) {
            address = machineAddress(args.memoryReference);
            size = args.bytes === undefined ? 1 : Number(args.bytes);
          } else if (
            args.variablesReference === 2 &&
            typeof args.name === 'string' &&
            /^0x[0-9a-f]+:0x[0-9a-f]+(?: ← (?:E?SP))?$/i.test(args.name)
          ) {
            const r = await runtime.registers();
            address = stackAddress(r, Number(/^0x[0-9a-f]+:(0x[0-9a-f]+)/i.exec(args.name)![1]));
            size = cpuMode(r) === 'protected32' ? 4 : 2;
          } else {
            address = machineAddress(args.name);
            size = args.bytes === undefined ? 1 : Number(args.bytes);
          }
          const point = watchpoint({ address, size, access: 'write' });
          this.response(request, {
            dataId: memoryDataId(point.address, point.size),
            description: `${hex(point.address)} · ${point.size} 字节`,
            accessTypes: ['read', 'write', 'readWrite'],
            canPersist: true
          });
        } catch (error) {
          this.response(request, {
            dataId: null,
            description: error instanceof Error ? error.message : String(error)
          });
        }
        return true;
      }
    }
    return false;
  }
}
