import { QemuGdbBackend } from '../backends/gdb/qemuBackend';
import { GdbSourceAdapter } from '../backends/gdb/sourceAdapter';
import { icedDecoder } from '../backends/iced/decoder';
import { buildSourceMaps } from '../backends/nasm/sources';
import { QemuRspBackend } from '../backends/qemu/rspBackend';
import { QemuVirtualMachine } from '../backends/qemu/virtualMachine';
import { Processes } from '../platform/processes';
import type { SessionLifecycle } from '../ports/machine';
import type { AssemblySessionOptions, SessionOptions, SessionResources } from '../ports/session';
import type { SourceBackend } from '../ports/source';
import { ManagedProjectBuilder } from '../project/builder';
import type { Project } from '../project/model';
import type { AdapterOptions, CAdapterOptions, QemuDisplay } from './options';

async function resources<Backend extends SessionLifecycle>(
  options: Pick<AdapterOptions, 'isTrusted' | 'createDisplay'>,
  project: Project,
  create: (args: string[]) => Backend
): Promise<SessionResources<Backend>> {
  const display: QemuDisplay | undefined = await options.createDisplay?.(project);
  try {
    if (!options.isTrusted()) throw new Error('请先信任工作区，才能启动或控制调试器');
    return { backend: create(display?.args ?? []), display };
  } catch (error) {
    await display?.dispose();
    throw error;
  }
}

export function assemblyServices(options: AdapterOptions): AssemblySessionOptions {
  const builder = new ManagedProjectBuilder(new Processes(), options.buildProject);
  return {
    ...options,
    decoder: icedDecoder,
    builder,
    sources: { load: (project, log, cancelled) => buildSourceMaps(project, builder, log, cancelled) },
    createResources: (project, log) =>
      resources(
        options,
        project,
        (args) =>
          options.runtimeFactory?.(project, log, args) ??
          new QemuRspBackend(project, new QemuVirtualMachine(project, new Processes(), log, args))
      )
  };
}

export function sourceServices(options: CAdapterOptions): SessionOptions<SourceBackend> {
  return {
    ...options,
    decoder: icedDecoder,
    builder: new ManagedProjectBuilder(new Processes(), options.buildProject),
    createResources: (project, log) =>
      resources(options, project, (args) => {
        if (options.backendFactory) return options.backendFactory(project, log, args);
        const connection =
          options.runtimeFactory?.(project, log, args) ??
          new QemuGdbBackend(project, log, new QemuVirtualMachine(project, new Processes(), log, args));
        return new GdbSourceAdapter(connection, project.root, project.debug?.elf);
      })
  };
}

export function createRunMachine(
  project: Project,
  log: (text: string) => void,
  args: readonly string[] = []
) {
  return new QemuVirtualMachine(project, new Processes(), log, args);
}
