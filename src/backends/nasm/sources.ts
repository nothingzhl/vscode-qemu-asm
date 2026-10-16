import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectBuilder } from '../../ports/build';
import type { Project } from '../../project/model';
import { SourceMap, parseListing } from './listing';
/** Temporary listings are owned here and removed on build/parse/cancellation failures. */
export async function buildSourceMaps(
  project: Project,
  builder: ProjectBuilder,
  log: (text: string) => void,
  cancelled: () => boolean
): Promise<readonly SourceMap[]> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu asm debug '));
  try {
    const listing = path.join(temp, 'boot.lst');
    const result = await builder.build(project, log, cancelled, listing);
    const maps: SourceMap[] = [];
    for (const unit of result.units) {
      if (!unit.listingPath) throw new Error('构建未生成调试 listing');
      const source = await fs.readFile(unit.source, 'utf8');
      const sourcePath = await fs.realpath(unit.source);
      maps.push(
        parseListing(await fs.readFile(unit.listingPath, 'utf8'), sourcePath, source, {
          loadAddress: unit.loadAddress,
          maxBytes: unit.size,
          initialBits: maps.length === 0 ? 16 : 'auto'
        })
      );
    }
    return maps;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
