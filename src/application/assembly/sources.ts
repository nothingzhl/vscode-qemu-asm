import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SourceMap } from '../../domain/source/map';
import type { PhysicalMemoryReader, RegisterReader } from '../../ports/machine';
import { inspectPaging } from '../inspection/paging';
import { SourceMaps } from './maps';
type MappingReader = RegisterReader & PhysicalMemoryReader;
/** Owns listing maps and source breakpoint intent for one NASM session. */
export class AssemblySources {
  map?: SourceMap;
  maps?: SourceMaps;
  sourceKey = '';
  readonly lines = new Map<string, number[]>();
  constructor(
    private readonly requireStopped: () => MappingReader,
    private readonly isCurrent: (reader: MappingReader) => boolean
  ) {}
  async set(maps: readonly SourceMap[]): Promise<void> {
    this.maps = new SourceMaps(maps);
    this.map = maps[0];
    this.sourceKey = await this.fileKey(this.map.sourcePath);
  }
  sourceMap(file: string): SourceMap | undefined {
    return this.maps?.forSource(file) ?? (file === this.sourceKey ? this.map : undefined);
  }
  locate(
    address: number,
    bits?: 16 | 32
  ): { map: SourceMap; entry: SourceMap['entries'][number] } | undefined {
    const entry = this.map?.forAddress(address);
    const located =
      this.maps?.forAddress(address) ?? (entry && this.map ? { map: this.map, entry } : undefined);
    return located && (bits === undefined || (located.entry.bits ?? 16) === bits) ? located : undefined;
  }
  async locateLive(
    address: number,
    bits: 16 | 32,
    registers: Record<string, number>
  ): Promise<ReturnType<AssemblySources['locate']>> {
    const located = this.locate(address, bits);
    if (!located || !((registers.cr0 ?? 0) & 0x80000000)) return located;
    const runtime = this.requireStopped();
    const firstAddress = located.entry.address;
    const lastAddress = firstAddress + located.entry.size - 1;
    if (lastAddress > 0xffffffff) return undefined;
    try {
      const first = await inspectPaging(runtime, { address: firstAddress });
      if (first.physicalAddress !== firstAddress) return undefined;
      if (firstAddress >>> 12 !== lastAddress >>> 12) {
        const last = await inspectPaging(runtime, { address: lastAddress });
        if (last.physicalAddress !== lastAddress) return undefined;
      }
    } catch (error) {
      // Older QEMU can still debug virtual machine code without the optional
      // physical-memory extension. Unverified source mapping stays absent.
      if (!this.isCurrent(runtime)) throw error;
      return undefined;
    }
    return located;
  }
  addresses(): number[] {
    return [
      ...new Set(
        [...this.lines].flatMap(([file, lines]) => {
          const map = this.sourceMap(file);
          return lines.flatMap((line) => {
            const entry = map?.forLine(line);
            return entry ? [entry.address] : [];
          });
        })
      )
    ];
  }
  async fileKey(file: string): Promise<string> {
    let canonical = path.normalize(file);
    try {
      canonical = await fs.realpath(file);
    } catch {
      /* Unknown source files remain unverified. */
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }
}
