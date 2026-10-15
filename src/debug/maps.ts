import * as path from 'node:path';
import { SourceEntry, SourceMap } from './listing';

function sourceKey(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Independently assembled stages, each with one fixed and non-overlapping load span. */
export class SourceMaps {
  readonly maps: readonly SourceMap[];
  private readonly sources = new Map<string, SourceMap>();
  private readonly byAddress: readonly SourceMap[];

  constructor(maps: readonly SourceMap[]) {
    this.maps = Object.freeze([...maps]);
    this.byAddress = maps.filter(map => map.byteLength > 0).sort((a, b) => a.origin - b.origin);
    for (const map of maps) {
      const key = sourceKey(map.sourcePath);
      if (this.sources.has(key)) throw new Error(`调试源码重复：${map.sourcePath}`);
      this.sources.set(key, map);
    }
    let previous: SourceMap | undefined;
    for (const map of this.byAddress) {
      if (previous && map.origin < previous.origin + previous.byteLength) {
        throw new Error(`调试阶段加载地址重叠：${previous.sourcePath} 与 ${map.sourcePath}`);
      }
      previous = map;
    }
  }

  forSource(sourcePath: string): SourceMap | undefined { return this.sources.get(sourceKey(sourcePath)); }

  /** Data, padding and external firmware deliberately have no executable source. */
  forAddress(address: number): { map: SourceMap; entry: SourceEntry } | undefined {
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) return undefined;
    let low = 0;
    let high = this.byAddress.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const map = this.byAddress[middle];
      if (address < map.origin) high = middle - 1;
      else if (address >= map.origin + map.byteLength) low = middle + 1;
      else {
        const entry = map.forAddress(address);
        return entry && { map, entry };
      }
    }
    return undefined;
  }
}
