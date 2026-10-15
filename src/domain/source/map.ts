/** A single executable source line, with its fixed linear load address. */
export interface SourceEntry {
  readonly line: number;
  readonly address: number;
  readonly size: number;
  readonly text: string;
  /** Legacy manually constructed maps omit this and mean 16-bit code. */
  readonly bits?: 16 | 32;
}

/** NASM's bin listing offsets become addresses at the configured load address. */
export class SourceMap {
  readonly entries: readonly SourceEntry[];
  /** The complete image span, including data and padding with no source mapping. */
  readonly byteLength: number;
  private readonly lines = new Map<number, SourceEntry>();

  constructor(
    readonly sourcePath: string,
    readonly origin: number,
    entries: readonly SourceEntry[],
    byteLength?: number
  ) {
    this.entries = entries.map((entry) => Object.freeze({ ...entry })).sort((a, b) => a.address - b.address);
    this.byteLength =
      byteLength ??
      this.entries.reduce((size, entry) => Math.max(size, entry.address + entry.size - origin), 0);
    if (
      !Number.isSafeInteger(origin) ||
      origin < 0 ||
      origin > 0xffffffff ||
      !Number.isSafeInteger(this.byteLength) ||
      this.byteLength < 0 ||
      origin + this.byteLength > 0x100000000
    ) {
      throw new Error('源码映射的加载地址或镜像跨度超出 32 位地址范围');
    }
    let previousEnd = origin;
    for (const entry of this.entries) {
      if (
        !Number.isSafeInteger(entry.address) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size <= 0 ||
        entry.address < previousEnd ||
        entry.address + entry.size > origin + this.byteLength
      ) {
        throw new Error('源码映射的指令范围重叠或超出镜像跨度');
      }
      previousEnd = entry.address + entry.size;
      this.lines.set(entry.line, entry);
    }
  }

  /** Labels, comments and data never silently move a breakpoint onto another line. */
  forLine(line: number): SourceEntry | undefined {
    return this.lines.get(line);
  }

  /** Only bytes inside an instruction map to source; BIOS and data do not. */
  forAddress(address: number): SourceEntry | undefined {
    if (!Number.isSafeInteger(address)) return undefined;
    let low = 0;
    let high = this.entries.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const entry = this.entries[mid];
      if (address < entry.address) high = mid - 1;
      else if (address >= entry.address + entry.size) low = mid + 1;
      else return entry;
    }
    return undefined;
  }
}
