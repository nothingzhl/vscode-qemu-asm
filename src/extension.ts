import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DisplayController } from './display/controller';
import { AssemblyDebugAdapter } from './debug/adapter';
import { CSourceDebugAdapter } from './debug/cAdapter';
import { InspectorProvider } from './inspector/provider';
import { build } from './project/build';
import { createProject } from './project/create';
import { parseErrors } from './project/diagnostics';
import { Processes } from './platform/processes';
import { qemuArguments } from './backends/qemu/arguments';
import { resolveProject } from './project/config';
import { Project } from './project/model';

import { checkEnvironment, formatEnvironmentReport } from './dependencies/doctor';
import type { CapabilityLedger, CapabilityReport } from './dependencies/capabilities';

let processes: Processes | undefined;
let displays: DisplayController | undefined;
const debugAdapters = new Set<AssemblyDebugAdapter | CSourceDebugAdapter>();
export function activate(context: vscode.ExtensionContext): void {
  const runner = processes = new Processes();
  const output = vscode.window.createOutputChannel('QEMU Assembly');
  const diagnostics = vscode.languages.createDiagnosticCollection('qemu-asm');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'qemuAsm.stop';
  const state = (text: string) => { status.text = `QEMU: ${text}`; status.show(); };
  state('已停止');
  let busy = false;
  let generation = 0;
  let running = false;
  const trusted = () => { if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区，才可执行工具或创建项目。'); };
  const display = displays = new DisplayController(context, trusted, text => output.append(text));
  const inspector = new InspectorProvider(context);
  const reports = new Map<string, string>();
  let reportSequence = 0;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('qemu-asm-report', { provideTextDocumentContent: uri => reports.get(uri.toString()) ?? JSON.stringify({ status: 'expired', reason: '此报告属于已结束的扩展会话，请重新执行依赖报告命令。' }, null, 2) }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'qemu-asm-report') reports.delete(document.uri.toString()); })
  );
  context.subscriptions.push(inspector,
    vscode.window.registerWebviewViewProvider('qemuAsm.inspector', inspector, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', { createDebugAdapterTracker: session => inspector.createDebugAdapterTracker(session) }),
    vscode.commands.registerCommand('qemuAsm.showInspector', () => vscode.commands.executeCommand('qemuAsm.inspector.focus')),
    vscode.commands.registerCommand('qemuAsm.showDisassembly', () => inspector.show('disassembly')),
    vscode.commands.registerCommand('qemuAsm.showDataBreakpoints', () => inspector.show('watchpoints')),
    vscode.commands.registerCommand('qemuAsm.showPaging', () => inspector.show('paging'))
  );
  async function folder(): Promise<vscode.WorkspaceFolder> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先打开项目所在文件夹。');
    const selected = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择汇编项目所在工作区' });
    if (!selected) throw new Error('已取消选择');
    if (selected.uri.scheme !== 'file') throw new Error('仅支持文件系统工作区。');
    return selected;
  }
  async function project(readConfig = true, explicitFolder?: vscode.WorkspaceFolder): Promise<Project> {
    const selected = explicitFolder ?? await folder();
    const settings = vscode.workspace.getConfiguration('qemuAsm', selected.uri);
    const base = resolveProject(selected.uri.fsPath, settings.get('projectDirectory'), {}, { nasm: settings.get('nasmPath'), qemu: settings.get('qemuPath'), gdb: settings.get('gdbPath'), qemuArgs: settings.get('qemuArgs') });
    if (!readConfig) return base;
    let data: unknown;
    try { data = JSON.parse(await fs.readFile(path.join(base.root, 'qemu-asm.json'), 'utf8')); }
    catch (error) { throw new Error(`无法读取 qemu-asm.json，请先创建项目。${String(error)}`); }
    return resolveProject(selected.uri.fsPath, settings.get('projectDirectory'), data, { nasm: settings.get('nasmPath'), qemu: settings.get('qemuPath'), gdb: settings.get('gdbPath'), qemuArgs: settings.get('qemuArgs') });
  }
  async function stop(): Promise<void> { generation++; await Promise.all([runner.stop(), display.stop(), ...[...debugAdapters].map(adapter => adapter.dispose())]); running = false; state('已停止'); }
  async function compile(p: Project, token: number): Promise<void> {
    diagnostics.clear();
    state('构建中');
    let text = '';
    try {
      await build(p, runner, chunk => { output.append(chunk); text += chunk; }, () => token !== generation);
    } finally {
      for (const error of parseErrors(text, p.root)) {
        const uri = vscode.Uri.file(error.file);
        const previous = diagnostics.get(uri) ?? [];
        diagnostics.set(uri, [...previous, new vscode.Diagnostic(new vscode.Range(error.line, 0, error.line, 1), error.message, error.message.startsWith('warning:') ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error)]);
      }
    }
    output.appendLine(`构建成功：${p.image}`);
  }
  function register(name: string, action: () => Promise<unknown>, exclusive = true): void {
    context.subscriptions.push(vscode.commands.registerCommand(`qemuAsm.${name}`, async () => {
      if (exclusive && busy) { void vscode.window.showWarningMessage('正在执行操作，请稍候或停止。'); return; }
      if (exclusive) busy = true;
      try { trusted(); output.show(true); return await action(); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); state('失败'); void vscode.window.showErrorMessage(`QEMU Assembly：${message}`); }
      finally { if (exclusive) busy = false; }
    }));
  }
  async function environmentReport() {
    const selected = await folder();
    let p = await project(false, selected);
    try { await fs.access(path.join(p.root, 'qemu-asm.json')); p = await project(true, selected); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const token = generation;
    let runtimeReport: CapabilityReport | undefined;
    const session = vscode.debug.activeDebugSession;
    if (session?.type === 'qemu-asm') {
      try { runtimeReport = await session.customRequest('qemuAsm.dependencyReport') as CapabilityReport; }
      catch (error) { output.appendLine(`当前会话报告暂不可用：${String(error)}`); }
    }
    trusted();
    const report = await checkEnvironment(p, runner, { cancelled: () => token !== generation || !vscode.workspace.isTrusted, runtimeReport });
    output.append(formatEnvironmentReport(report));
    output.appendLine(`VS Code 扩展宿主：${vscode.env.remoteName ?? '本地'}；工具在此宿主执行。`);
    return report;
  }
  register('checkEnvironment', async () => {
    const report = await environmentReport();
    void vscode.window.showInformationMessage(report.status === 'passed' ? '工具解析与版本检查通过；协议能力请查看实际调试会话报告。' : '依赖检查发现失败项或已取消，请查看 QEMU Assembly 日志。');
    return report;
  });
  register('showDependencyReport', async () => {
    const report = await environmentReport();
    const uri = vscode.Uri.from({ scheme: 'qemu-asm-report', path: `/dependency-report-${++reportSequence}.json` });
    reports.set(uri.toString(), JSON.stringify(report, null, 2) + '\n');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'json');
    await vscode.window.showTextDocument(document, { preview: false });
    return report;
  });
  function displayEnabled(selected?: vscode.WorkspaceFolder): boolean {
    return vscode.workspace.getConfiguration('qemuAsm', selected?.uri).get<string>('displayMode', 'auto') !== 'off';
  }
  async function createExample(template: 'boot' | 'protected'): Promise<void> {
    const selected = await folder();
    const dirs = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: selected.uri, openLabel: '在此目录创建示例' });
    if (!dirs?.[0]) return;
    if (dirs[0].scheme !== 'file') throw new Error('仅支持本地目录');
    trusted();
    await createProject(dirs[0].fsPath, template);
    const relative = path.relative(selected.uri.fsPath, dirs[0].fsPath) || '.';
    await vscode.workspace.getConfiguration('qemuAsm', selected.uri).update('projectDirectory', relative, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dirs[0].fsPath, template === 'protected' ? 'stage2.asm' : 'boot.asm')));
    void vscode.window.showInformationMessage(template === 'protected' ? '二阶段保护模式示例已创建，可设置断点后执行“开始引导调试”。' : '引导示例已创建，可执行“构建并运行”。');
  }
  register('createProject', () => createExample('boot'));
  register('createProtectedProject', () => createExample('protected'));
  register('build', async () => {
    await stop();
    const token = generation;
    if (!await vscode.workspace.saveAll(false)) throw new Error('文件未能保存，已取消构建。');
    const p = await project();
    trusted();
    if (token !== generation) return;
    await compile(p, token); if (token === generation) state('构建完成');
  });
  register('run', async () => {
    await stop();
    const token = generation;
    if (!await vscode.workspace.saveAll(false)) throw new Error('文件未能保存，已取消构建。');
    const selected = await folder();
    const p = await project(true, selected);
    trusted();
    if (token !== generation) return;
    await compile(p, token);
    if (token !== generation) return;
    const screen = await display.createOptional({ enabled: displayEnabled(selected) });
    if (token !== generation) { if (screen) await display.stop(screen); return; }
    let run: ReturnType<Processes['start']>;
    try {
      run = runner.start(p.qemu, [...qemuArguments(p), ...(screen?.args ?? [])], p.root, text => output.append(text));
      await run.ready;
    } catch (error) { if (screen) await display.stop(screen); throw error; }
    if (screen) void run.done.then(() => display.stop(screen), () => display.stop(screen)).catch(error => output.appendLine(String(error)));
    if (screen) await display.connect(screen);
    if (token !== generation) { await runner.stop(); return; }
    running = true; state('运行中（点击停止）');
    output.appendLine('QEMU 已启动，使用“停止”结束运行。');
    void run.done.then(() => {
      if (generation === token) { running = false; state('已停止'); }
    }, error => {
      if (generation === token) { running = false; state('失败'); output.appendLine(String(error)); void vscode.window.showErrorMessage(`QEMU 启动或运行失败：${String(error)}`); }
    });
  });
  context.subscriptions.push(vscode.commands.registerCommand('qemuAsm.showDisplay', () => display.show()));
  register('debug', async () => {
    const selected = await folder();
    await vscode.debug.startDebugging(selected, { type: 'qemu-asm', request: 'launch', name: '操作系统学习：16/32 位引导调试', stopOnEntry: true });
  });
  register('stop', stop, false);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('qemu-asm', {
      provideDebugConfigurations: () => [{ type: 'qemu-asm', request: 'launch', name: '操作系统学习：16/32 位引导调试', stopOnEntry: true }],
      resolveDebugConfiguration: async (selected, config) => {
        try {
          trusted();
          const target = selected ?? await folder();
          if (target.uri.scheme !== 'file') throw new Error('调试仅支持文件系统工作区');
          await stop();
          if (!await vscode.workspace.saveAll(false)) throw new Error('文件未能保存，已取消调试');
          trusted();
          return { ...config, type: 'qemu-asm', request: 'launch', name: config.name || '16/32 位引导调试', __workspace: target.uri.toString() };
        } catch (error) { void vscode.window.showErrorMessage(String(error)); return undefined; }
      }
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('qemu-asm', {
      createDebugAdapterDescriptor: async session => {
        trusted();
        const token = generation;
        const selected = session.workspaceFolder ?? vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === session.configuration.__workspace);
        if (!selected) throw new Error('调试会话缺少所选工作区');
        const configured = await project(true, selected);
        trusted();
        if (token !== generation) throw new Error('调试启动已取消');
        if (configured.build && !configured.debug) throw new Error('外部构建的源码调试需要在 qemu-asm.json 中配置 debug.elf。');
        const Adapter = configured.debug ? CSourceDebugAdapter : AssemblyDebugAdapter;
        const adapter = new Adapter({ getProject: () => project(true, selected), isTrusted: () => vscode.workspace.isTrusted, log: text => output.append(text), createDisplay: async () => {
          const screen = await display.createOptional({ enabled: displayEnabled(selected) });
          if (!screen) return undefined;
          return {
            args: screen.args,
            observeCapabilities: (ledger: CapabilityLedger) => {
              screen.on('status', (status: { state: string; message?: string }) => {
                if (status.state === 'connected') ledger.record('qemu.display', { state: 'unknown', evidence: 'protocol', reason: '当前 QEMU 的 QMP 连接与能力协商成功；实际截图及共享文件路径尚未验证' });
                else if (status.state === 'error') ledger.record('qemu.display', { state: 'unsupported', evidence: 'protocol', reason: status.message ?? '当前显示连接或截图失败' });
              });
              screen.on('frame', (frame: { width: number; height: number }) => ledger.record('qemu.display', { state: 'supported', evidence: 'integration', reason: '已读取当前 QEMU 的截图并转换为显示画面', details: { width: frame.width, height: frame.height } }));
            },
            connect: () => display.connect(screen), dispose: () => display.stop(screen)
          };
        } });
        debugAdapters.add(adapter);
        const dispose = adapter.dispose.bind(adapter);
        adapter.dispose = async () => { try { await dispose(); } finally { debugAdapters.delete(adapter); } };
        state('调试中');
        return new vscode.DebugAdapterInlineImplementation(adapter);
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => { if (session.type === 'qemu-asm') state('已停止'); })
  );
  context.subscriptions.push(output, diagnostics, status, { dispose: () => { generation++; if (running) running = false; void runner.dispose(); void display.dispose(); for (const adapter of debugAdapters) void adapter.dispose(); } });
}
export async function deactivate(): Promise<void> { await Promise.all([processes?.dispose(), displays?.dispose(), ...[...debugAdapters].map(adapter => adapter.dispose())]); }
