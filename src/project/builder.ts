import { Processes } from '../platform/processes';
import type { ProjectBuilder } from '../ports/build';
import { build } from './build';
import type { Project } from './model';

/** One build owner per caller, including its external compiler descendants. */
export class ManagedProjectBuilder implements ProjectBuilder {
  constructor(
    private readonly processes: Processes,
    private readonly compile = build
  ) {}
  build(project: Project, log: (text: string) => void, cancelled: () => boolean, listingPath?: string) {
    return this.compile(project, this.processes, log, cancelled, listingPath);
  }
  stop() {
    return this.processes.stop();
  }
  dispose() {
    return this.processes.dispose();
  }
}
