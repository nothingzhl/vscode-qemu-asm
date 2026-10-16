import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SourceBindings } from '../../application/source/bindings';
import type { Request, Respond } from './protocol';
type Results = Map<number, Record<string, unknown>>;
export class SourceBreakpointRequests {
  readonly desiredSources = new Map<string, number[]>();
  constructor(
    private readonly bindings: SourceBindings,
    private readonly update: (
      change: () => Promise<Results>,
      report: (results: Results) => void
    ) => Promise<void>,
    private readonly trust: () => void,
    private readonly response: Respond
  ) {}
  async fileKey(file: string): Promise<string> {
    let canonical = path.resolve(file);
    try {
      canonical = await fs.realpath(canonical);
    } catch {}
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }
  async handle(request: Request): Promise<boolean> {
    if (request.command !== 'setBreakpoints') return false;
    const args = request.arguments ?? {};
    this.trust();
    const file =
      typeof (args.source as { path?: unknown } | undefined)?.path === 'string'
        ? await this.fileKey((args.source as { path: string }).path)
        : '';
    if (!file) throw new Error('源码断点需要 source.path');
    const inputs = Array.isArray(args.breakpoints) ? (args.breakpoints as Record<string, unknown>[]) : [];
    if (inputs.length > 256) throw new Error('每个源文件最多设置 256 个断点');
    const lines = inputs
      .filter(
        (item) =>
          Number.isInteger(item.line) &&
          Number(item.line) > 0 &&
          !item.condition &&
          !item.hitCondition &&
          !item.logMessage
      )
      .map((item) => Number(item.line));
    await this.update(
      () => this.bindings.replaceSource(file, lines),
      (results) => {
        this.desiredSources.set(file, lines);
        this.response(request, {
          breakpoints: inputs.map((item) =>
            item.condition || item.hitCondition || item.logMessage
              ? { verified: false, line: item.line, message: '暂不支持条件、命中次数或日志断点' }
              : (results.get(Number(item.line)) ?? {
                  verified: false,
                  line: item.line,
                  message: '行号必须为正整数'
                })
          )
        });
      }
    );
    return true;
  }
}
