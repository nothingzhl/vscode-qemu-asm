import type { Project } from '../project/model';
import type { ProjectBuilder } from './build';
import type { InstructionDecoder } from './instructions';
import type { SessionLifecycle } from './machine';
import type { DebugDisplay } from './presentation';

export interface SessionResources<Backend extends SessionLifecycle> {
  backend: Backend;
  display?: DebugDisplay;
}
export interface SessionOptions<Backend extends SessionLifecycle> {
  getProject: () => Promise<Project>;
  isTrusted: () => boolean;
  log?: (text: string) => void;
  builder: ProjectBuilder;
  decoder: InstructionDecoder;
  createResources: (project: Project, log: (text: string) => void) => Promise<SessionResources<Backend>>;
}
