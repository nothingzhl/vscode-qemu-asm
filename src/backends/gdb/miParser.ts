export type MiValue = string | MiTuple | MiValue[];
export interface MiTuple { [key: string]: MiValue }
export interface MiRecord {
  token?: number;
  type: 'result' | 'exec' | 'status' | 'notify' | 'console' | 'target' | 'log' | 'prompt';
  class?: string;
  results: MiTuple;
  text?: string;
  /** 本次请求期间收到的 console / target 流，适用于 interpreter-exec console。 */
  console?: string;
}

/** MI 使用 C 字符串而不是 shell 或 JSON 字符串；非 ASCII 字节按 UTF-8 八进制编码。 */
export function miQuote(value: string): string {
  let result = '"';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (byte === 34 || byte === 92) result += `\\${String.fromCharCode(byte)}`;
    else if (byte === 10) result += '\\n';
    else if (byte === 13) result += '\\r';
    else if (byte === 9) result += '\\t';
    else if (byte >= 32 && byte <= 126) result += String.fromCharCode(byte);
    else result += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return result + '"';
}

class Parser {
  private index = 0;
  private nodes = 0;
  private readonly repeated = new WeakMap<MiTuple, Set<string>>();
  constructor(private readonly input: string) { }

  record(): MiRecord | undefined {
    if (/^\(gdb\)\s*$/.test(this.input)) return { type: 'prompt', results: {} };
    const head = /^(\d*)([\^*+=~@&])/.exec(this.input);
    if (!head) return undefined;
    const token = head[1] ? Number(head[1]) : undefined;
    if (token !== undefined && !Number.isSafeInteger(token)) throw new Error('MI 请求编号溢出');
    this.index = head[0].length;
    const types: Record<string, MiRecord['type']> = { '^': 'result', '*': 'exec', '+': 'status', '=': 'notify', '~': 'console', '@': 'target', '&': 'log' };
    const type = types[head[2]];
    if (['console', 'target', 'log'].includes(type)) {
      const text = this.string();
      this.end();
      return { token, type, results: {}, text };
    }
    const name = this.identifier();
    const results: MiTuple = {};
    while (this.index < this.input.length) {
      this.expect(',');
      this.result(results, 0);
    }
    return { token, type, class: name, results };
  }

  private result(target: MiTuple, depth: number): void {
    const key = this.identifier();
    this.expect('=');
    const value = this.value(depth + 1);
    if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    else {
      // 保留重复键；常见于 stack=[frame={...},frame={...}] 的旧版 GDB 输出。
      const old = target[key];
      let repeated = this.repeated.get(target);
      if (!repeated) { repeated = new Set(); this.repeated.set(target, repeated); }
      if (repeated.has(key)) (old as MiValue[]).push(value);
      else { target[key] = [old, value]; repeated.add(key); }
    }
  }

  private value(depth: number): MiValue {
    if (depth > 64 || ++this.nodes > 100000) throw new Error('MI 数据嵌套或元素数量超限');
    const character = this.input[this.index];
    if (character === '"') return this.string();
    if (character === '{') {
      this.index++;
      const tuple: MiTuple = {};
      if (this.input[this.index] !== '}') {
        this.result(tuple, depth);
        while (this.input[this.index] === ',') { this.index++; this.result(tuple, depth); }
      }
      this.expect('}');
      return tuple;
    }
    if (character === '[') {
      this.index++;
      const list: MiValue[] = [];
      if (this.input[this.index] !== ']') {
        const item = () => {
          if (/^[A-Za-z_][\w.-]*=/.test(this.input.slice(this.index))) {
            const tuple: MiTuple = {};
            this.result(tuple, depth);
            list.push(tuple);
          } else list.push(this.value(depth + 1));
        };
        item();
        while (this.input[this.index] === ',') { this.index++; item(); }
      }
      this.expect(']');
      return list;
    }
    throw new Error(`MI 值格式无效（位置 ${this.index}）`);
  }

  private string(): string {
    this.expect('"');
    const bytes: Buffer[] = [];
    let plain = '';
    const flush = () => { if (plain) { bytes.push(Buffer.from(plain, 'utf8')); plain = ''; } };
    while (this.index < this.input.length) {
      const character = this.input[this.index++];
      if (character === '"') { flush(); return Buffer.concat(bytes).toString('utf8'); }
      if (character !== '\\') { plain += character; continue; }
      flush();
      if (this.index >= this.input.length) break;
      const escaped = this.input[this.index++];
      const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34, "'": 39, '?': 63 };
      if (Object.hasOwn(simple, escaped)) bytes.push(Buffer.from([simple[escaped]]));
      else if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && /[0-7]/.test(this.input[this.index] ?? 'x')) octal += this.input[this.index++];
        bytes.push(Buffer.from([parseInt(octal, 8) & 255]));
      } else if (escaped === 'x') {
        let hex = '';
        while (/[0-9a-f]/i.test(this.input[this.index] ?? 'z')) hex += this.input[this.index++];
        if (!hex || hex.length > 2) throw new Error('MI 十六进制转义无效');
        bytes.push(Buffer.from([parseInt(hex, 16)]));
      } else throw new Error('MI C 字符串包含无效转义');
    }
    throw new Error('MI C 字符串未结束');
  }

  private identifier(): string {
    const match = /^[A-Za-z_][\w.-]*/.exec(this.input.slice(this.index));
    if (!match) throw new Error(`MI 字段名无效（位置 ${this.index}）`);
    this.index += match[0].length;
    return match[0];
  }
  private expect(character: string): void {
    if (this.input[this.index++] !== character) throw new Error(`MI 缺少 ${character}`);
  }
  private end(): void { if (this.index !== this.input.length) throw new Error('MI 记录尾部无效'); }
}

export function parseMiRecord(line: string): MiRecord | undefined {
  if (line.length > 4 * 1024 * 1024) throw new Error('MI 记录过大');
  return new Parser(line.replace(/\r$/, '')).record();
}
