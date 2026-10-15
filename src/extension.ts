import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { build, createProject, execute, parseErrors, Processes, qemuArguments, resolveProject, Project } from './core';

let processes: Processes | undefined;
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
  async function folder(): Promise<vscode.WorkspaceFolder> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先打开项目所在文件夹。');
    const selected = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择汇编项目所在工作区' });
    if (!selected) throw new Error('已取消选择');
    if (selected.uri.scheme !== 'file') throw new Error('仅支持文件系统工作区。');
    return selected;
  }
  async function project(readConfig = true): Promise<Project> {
    const selected = await folder();
    const settings = vscode.workspace.getConfiguration('qemuAsm', selected.uri);
    const base = resolveProject(selected.uri.fsPath, settings.get('projectDirectory'), {}, { nasm: settings.get('nasmPath'), qemu: settings.get('qemuPath'), qemuArgs: settings.get('qemuArgs') });
    if (!readConfig) return base;
    let data: unknown;
    try { data = JSON.parse(await fs.readFile(path.join(base.root, 'qemu-asm.json'), 'utf8')); }
    catch (error) { throw new Error(`无法读取 qemu-asm.json，请先创建项目。${String(error)}`); }
    return resolveProject(selected.uri.fsPath, settings.get('projectDirectory'), data, { nasm: settings.get('nasmPath'), qemu: settings.get('qemuPath'), qemuArgs: settings.get('qemuArgs') });
  }
  async function stop(): Promise<void> { generation++; await runner.stop(); running = false; state('已停止'); }
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
  function register(name: string, action: () => Promise<void>, exclusive = true): void {
    context.subscriptions.push(vscode.commands.registerCommand(`qemuAsm.${name}`, async () => {
      if (exclusive && busy) { void vscode.window.showWarningMessage('正在执行操作，请稍候或停止。'); return; }
      if (exclusive) busy = true;
      try { trusted(); output.show(true); await action(); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); state('失败'); void vscode.window.showErrorMessage(`QEMU Assembly：${message}`); }
      finally { if (exclusive) busy = false; }
    }));
  }
  register('checkEnvironment', async () => {
    const p = await project(false);
    let missing = false;
    for (const [tool, args, setting] of [[p.nasm, ['-v'], 'nasmPath'], [p.qemu, ['--version'], 'qemuPath']] as const) {
      output.appendLine(`检测工具：${tool}`);
      try { await execute(runner, tool, [...args], p.workspace, text => output.append(text)); }
      catch (error) { missing = true; output.appendLine(`缺失或不可用：${String(error)}。请配置 qemuAsm.${setting}（可执行文件路径，不含命令参数）。`); }
    }
    void vscode.window.showInformationMessage(missing ? '环境检查发现缺失项，请查看 QEMU Assembly 日志。' : 'NASM 与 QEMU 环境检查通过。');
  });
  register('createProject', async () => {
    const selected = await folder();
    const dirs = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: selected.uri, openLabel: '在此目录创建示例' });
    if (!dirs?.[0]) return;
    if (dirs[0].scheme !== 'file') throw new Error('仅支持本地目录');
    trusted();
    await createProject(dirs[0].fsPath);
    const relative = path.relative(selected.uri.fsPath, dirs[0].fsPath) || '.';
    await vscode.workspace.getConfiguration('qemuAsm', selected.uri).update('projectDirectory', relative, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dirs[0].fsPath, 'boot.asm')));
    void vscode.window.showInformationMessage('引导示例已创建，可执行“构建并运行”。');
  });
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
    const p = await project();
    trusted();
    if (token !== generation) return;
    await compile(p, token);
    if (token !== generation) return;
    const run = runner.start(p.qemu, qemuArguments(p), p.root, text => output.append(text));
    await run.ready;
    if (token !== generation) { await runner.stop(); return; }
    running = true; state('运行中（点击停止）');
    output.appendLine('QEMU 已启动，使用“停止”结束运行。');
    void run.done.then(() => {
      if (generation === token) { running = false; state('已停止'); }
    }, error => {
      if (generation === token) { running = false; state('失败'); output.appendLine(String(error)); void vscode.window.showErrorMessage(`QEMU 启动或运行失败：${String(error)}`); }
    });
  });
  register('stop', stop, false);
  context.subscriptions.push(output, diagnostics, status, { dispose: () => { generation++; if (running) running = false; void runner.dispose(); } });
}
export async function deactivate(): Promise<void> { await processes?.dispose(); }
