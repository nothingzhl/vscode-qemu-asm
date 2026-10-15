import { AssemblySources } from '../../application/assembly/sources';
import { integer } from '../../application/format';
import type { Request, Respond } from './protocol';
const hex = (value: number) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(4, '0')}`;
export class AssemblyBreakpointRequests {
  constructor(
    private readonly sources: AssemblySources,
    private readonly update: (report: () => void) => Promise<void>,
    private readonly trust: () => void,
    private readonly response: Respond
  ) {}
  async handle(request: Request): Promise<boolean> {
    if (request.command !== 'setBreakpoints') return false;
    const args = request.arguments ?? {};
    this.trust();
    const source = args.source as { path?: string } | undefined;
    const file = source?.path ? await this.sources.fileKey(source.path) : '';
    const breakpoints = Array.isArray(args.breakpoints)
      ? (args.breakpoints as {
          line?: number;
          condition?: string;
          hitCondition?: string;
          logMessage?: string;
        }[])
      : [];
    const valid = breakpoints.filter((b) => !b.condition && !b.hitCondition && !b.logMessage);
    this.sources.lines.set(
      file,
      valid.map((b) => integer(b.line, 0))
    );
    await this.update(() => {
      this.response(request, {
        breakpoints: breakpoints.map((b) => {
          const entry =
            !b.condition && !b.hitCondition && !b.logMessage
              ? this.sources.sourceMap(file)?.forLine(integer(b.line, 0))
              : undefined;
          return {
            verified: !!entry,
            line: b.line,
            ...(entry
              ? { instructionReference: hex(entry.address) }
              : { message: '仅支持项目已配置阶段中可执行指令行的普通断点；标签、数据和条件断点不支持。' })
          };
        })
      });
    });
    return true;
  }
}
