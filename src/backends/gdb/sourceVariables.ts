import type { NamedSourceVariable, SourceVariable, SourceVariableReader } from '../../ports/source';
import type { GdbConnection } from './connection';
import { miQuote, MiTuple } from './miParser';
import { address, records, text } from './values';

export class GdbSourceVariables implements SourceVariableReader {
  constructor(private readonly connection: GdbConnection) {}

  async list(frame: number): Promise<NamedSourceVariable[]> {
    const result = await this.connection.mi(
      `-stack-list-variables --thread 1 --frame ${frame} --simple-values`
    );
    return records(result.results.variables).map((row) => ({
      name: text(row.name),
      value: text(row.value),
      type: text(row.type),
      argument: text(row.arg) === '1'
    }));
  }

  async create(expression: string, frame: number): Promise<SourceVariable> {
    const reply = await this.connection.mi(
      `-var-create --thread 1 --frame ${frame} - * ${miQuote(expression)}`
    );
    return this.variable(reply.results, expression);
  }

  async children(id: string, start: number, count: number): Promise<SourceVariable[]> {
    const reply = await this.connection.mi(
      `-var-list-children --all-values ${miQuote(id)} ${start} ${start + count}`
    );
    const children: SourceVariable[] = [];
    for (const row of records(reply.results.children, 'child')) {
      let expression: string | undefined;
      try {
        const path = await this.connection.mi(`-var-info-path-expression ${miQuote(text(row.name))}`);
        expression = text(path.results.path_expr) || undefined;
      } catch {
        /* GDB may expose a value with no C path expression. */
      }
      children.push(this.variable(row, expression));
    }
    return children;
  }

  async release(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.connection.mi(`-var-delete ${miQuote(id)}`);
      } catch {
        /* A frame disappearing can already have removed its variable objects. */
      }
    }
  }

  async address(expression: string, frame: number): Promise<{ address: number; size: number }> {
    const context = `--thread 1 --frame ${frame}`;
    const pointer = await this.connection.mi(
      `-data-evaluate-expression ${context} ${miQuote(`&(${expression})`)}`
    );
    const at = address(pointer.results.value);
    if (at === undefined) throw new Error('变量没有可读取的内存地址（可能被优化或位于寄存器）');
    const length = await this.connection.mi(
      `-data-evaluate-expression ${context} ${miQuote(`sizeof(${expression})`)}`
    );
    return { address: at, size: Number(text(length.results.value)) };
  }

  private variable(row: MiTuple, expression?: string): SourceVariable {
    return {
      id: text(row.name),
      name: text(row.exp),
      value: text(row.value, '<不可用>'),
      type: text(row.type),
      childCount: Number(text(row.numchild, '0')),
      hasMore: text(row.has_more) === '1',
      evaluateName: expression
    };
  }
}
