import type { BuildResult, Project } from '../project/model';
export interface ProjectBuilder {
  build(
    project: Project,
    log: (text: string) => void,
    cancelled: () => boolean,
    listingPath?: string
  ): Promise<BuildResult>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
