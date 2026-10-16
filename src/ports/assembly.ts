import type { SourceMap } from '../domain/source/map';
import type { Project } from '../project/model';
/** Produces verified fixed-load source maps; tool output and temporary artifacts remain implementation details. */
export interface AssemblySourceLoader {
  load(
    project: Project,
    log: (text: string) => void,
    cancelled: () => boolean
  ): Promise<readonly SourceMap[]>;
}
