import * as vscode from 'vscode';
import { RunSession } from './application/runSession';
import { createDebugAdapter } from './composition/createAdapter';
import { createRunMachine } from './composition/sessionServices';
import { DisplayController } from './display/controller';
import { compileProject } from './integration/vscode/build';
import { DependencyReports } from './integration/vscode/dependencyReports';
import { createDisplaySession } from './integration/vscode/displaySession';
import { createExample } from './integration/vscode/examples';
import { registerInspector } from './integration/vscode/inspector';
import { MachineProfiles } from './integration/vscode/machineProfiles';
import { selectWorkspace as folder } from './integration/vscode/projects';
import { Processes } from './platform/processes';
import { Project } from './project/model';

let processes: Processes | undefined;
let displays: DisplayController | undefined;
const debugAdapters = new Set<ReturnType<typeof createDebugAdapter>>();
let runs: RunSession | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const runner = (processes = new Processes());
  const output = vscode.window.createOutputChannel('QEMU Assembly');
  const diagnostics = vscode.languages.createDiagnosticCollection('qemu-asm');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'qemuAsm.stop';
  const state = (text: string) => {
    status.text = `QEMU: ${text}`;
    status.show();
  };
  state('已停止');
  let busy = false;
  let generation = 0;
  let running = false;
  const trusted = () => {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区，才可执行工具或创建项目。');
  };
  const display = (displays = new DisplayController(context, trusted, (text) => output.append(text)));
  registerInspector(context);
  const runSession = (runs = new RunSession());
  const profiles = new MachineProfiles(context, trusted);
  async function stop(): Promise<void> {
    generation++;
    await Promise.all([
      runner.stop(),
      runSession.stop(),
      display.stop(),
      ...[...debugAdapters].map((adapter) => adapter.dispose())
    ]);
    running = false;
    state('已停止');
  }
  async function compile(p: Project, token: number): Promise<void> {
    state(p.buildMode === 'existing' ? '验证产物中' : '构建中');
    await compileProject(p, runner, output, diagnostics, () => token !== generation);
  }
  function register(name: string, action: (...args: unknown[]) => Promise<unknown>, exclusive = true): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(`qemuAsm.${name}`, async (...args: unknown[]) => {
        if (exclusive && busy) {
          void vscode.window.showWarningMessage('正在执行操作，请稍候或停止。');
          return;
        }
        if (exclusive) busy = true;
        try {
          trusted();
          output.show(true);
          return await action(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(message);
          if (name !== 'selectMachineProfile' && name !== 'configureMachineProfiles') state('失败');
          void vscode.window.showErrorMessage(`QEMU Assembly：${message}`);
        } finally {
          if (exclusive) busy = false;
        }
      })
    );
  }
  const reports = new DependencyReports(
    context,
    output,
    runner,
    () => generation,
    trusted,
    profiles.read.bind(profiles)
  );
  register('checkEnvironment', () => reports.check());
  register('showDependencyReport', () => reports.show());
  register('selectMachineProfile', (argument) => profiles.select(argument));
  register('configureMachineProfiles', (argument) => profiles.configure(argument));
  register('createProject', () => createExample('boot', trusted));
  register('createProtectedProject', () => createExample('protected', trusted));
  register('build', async () => {
    await stop();
    const token = generation;
    if (!(await vscode.workspace.saveAll(false))) throw new Error('文件未能保存，已取消构建。');
    const p = await profiles.read();
    trusted();
    if (token !== generation) return;
    await compile(p, token);
    if (token === generation) state('构建完成');
  });
  register('run', async () => {
    await stop();
    const token = generation;
    if (!(await vscode.workspace.saveAll(false))) throw new Error('文件未能保存，已取消构建。');
    const selected = await folder();
    const p = await profiles.read(true, selected);
    trusted();
    if (token !== generation) return;
    await compile(p, token);
    if (token !== generation) return;
    const run = await runSession.start(async () => {
      const presentation = await createDisplaySession(display, p.displayMode !== 'off');
      try {
        trusted();
        return {
          machine: createRunMachine(p, (text) => output.append(text), presentation?.args),
          display: presentation
        };
      } catch (error) {
        await presentation?.dispose();
        throw error;
      }
    });
    if (token !== generation) {
      await runSession.stop();
      return;
    }
    running = true;
    state('运行中（点击停止）');
    output.appendLine('QEMU 已启动，使用“停止”结束运行。');
    void run.exited.then(
      () => {
        if (generation === token) {
          running = false;
          state('已停止');
        }
      },
      (error) => {
        if (generation === token) {
          running = false;
          state('失败');
          output.appendLine(String(error));
          void vscode.window.showErrorMessage(`QEMU 启动或运行失败：${String(error)}`);
        }
      }
    );
  });
  context.subscriptions.push(vscode.commands.registerCommand('qemuAsm.showDisplay', () => display.show()));
  register('debug', async () => {
    const selected = await folder();
    await vscode.debug.startDebugging(selected, {
      type: 'qemu-asm',
      request: 'launch',
      name: '操作系统学习：16/32 位引导调试',
      stopOnEntry: true
    });
  });
  register('stop', stop, false);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('qemu-asm', {
      provideDebugConfigurations: () => [
        { type: 'qemu-asm', request: 'launch', name: '操作系统学习：16/32 位引导调试', stopOnEntry: true }
      ],
      resolveDebugConfiguration: async (selected, config) => {
        try {
          trusted();
          const target = selected ?? (await folder());
          if (target.uri.scheme !== 'file') throw new Error('调试仅支持文件系统工作区');
          await stop();
          if (!(await vscode.workspace.saveAll(false))) throw new Error('文件未能保存，已取消调试');
          await profiles.read(true, target, config.machineProfile);
          trusted();
          return {
            ...config,
            type: 'qemu-asm',
            request: 'launch',
            name: config.name || '16/32 位引导调试',
            __workspace: target.uri.toString()
          };
        } catch (error) {
          void vscode.window.showErrorMessage(String(error));
          return undefined;
        }
      }
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('qemu-asm', {
      createDebugAdapterDescriptor: async (session) => {
        trusted();
        const token = generation;
        const selected =
          session.workspaceFolder ??
          vscode.workspace.workspaceFolders?.find(
            (item) => item.uri.toString() === session.configuration.__workspace
          );
        if (!selected) throw new Error('调试会话缺少所选工作区');
        const configured = await profiles.read(true, selected, session.configuration.machineProfile);
        trusted();
        if (token !== generation) throw new Error('调试启动已取消');
        if ((configured.build || configured.buildMode === 'existing' || configured.boot?.type === 'iso') && !configured.debug)
          throw new Error('外部构建或已有产物的源码调试需要在 qemu-asm.json 中配置 debug.elf。');
        const adapter = createDebugAdapter(configured, {
          getProject: () => profiles.read(true, selected, session.configuration.machineProfile),
          isTrusted: () => vscode.workspace.isTrusted,
          log: (text) => output.append(text),
          createDisplay: (project) => createDisplaySession(display, project.displayMode !== 'off')
        });
        debugAdapters.add(adapter);
        const dispose = adapter.dispose.bind(adapter);
        adapter.dispose = async () => {
          try {
            await dispose();
          } finally {
            debugAdapters.delete(adapter);
          }
        };
        state('调试中');
        return new vscode.DebugAdapterInlineImplementation(adapter);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === 'qemu-asm') state('已停止');
    })
  );
  context.subscriptions.push(output, diagnostics, status, {
    dispose: () => {
      generation++;
      if (running) running = false;
      void runner.dispose();
      void runSession.stop();
      void display.dispose();
      for (const adapter of debugAdapters) void adapter.dispose();
    }
  });
}
export async function deactivate(): Promise<void> {
  await Promise.all([
    processes?.dispose(),
    runs?.stop(),
    displays?.dispose(),
    ...[...debugAdapters].map((adapter) => adapter.dispose())
  ]);
}
