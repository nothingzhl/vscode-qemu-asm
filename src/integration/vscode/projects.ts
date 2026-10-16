import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveProject } from '../../project/config';
import type { Project } from '../../project/model';
import type { MachineProfileSelection } from '../../project/machineProfiles';

type ProfileChoice = MachineProfileSelection | ((project: Project) => MachineProfileSelection | undefined);

export async function selectWorkspace(): Promise<vscode.WorkspaceFolder> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('请先打开项目所在文件夹。');
  const selected =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择汇编项目所在工作区' });
  if (!selected) throw new Error('已取消选择');
  if (selected.uri.scheme !== 'file') throw new Error('仅支持文件系统工作区。');
  return selected;
}

export async function readProject(
  readConfig = true,
  explicitFolder?: vscode.WorkspaceFolder,
  selection?: ProfileChoice
): Promise<Project> {
  const selected = explicitFolder ?? (await selectWorkspace());
  const settings = vscode.workspace.getConfiguration('qemuAsm', selected.uri);
  const projectDirectory = settings.get('projectDirectory');
  const display = settings.inspect<string>('displayMode');
  const explicitDisplay = [display?.globalValue, display?.workspaceValue, display?.workspaceFolderValue].some(
    (value) => value !== undefined
  );
  const tools = {
    nasm: settings.get('nasmPath'),
    qemu: settings.get('qemuPath'),
    gdb: settings.get('gdbPath'),
    qemuArgs: settings.get('qemuArgs'),
    displayMode: explicitDisplay ? settings.get('displayMode') : undefined
  };
  const base = resolveProject(selected.uri.fsPath, projectDirectory, {}, tools);
  if (!readConfig) return base;
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(path.join(base.root, 'qemu-asm.json'), 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 qemu-asm.json，请先创建项目。${String(error)}`);
  }
  const choice = typeof selection === 'function' ? selection(base) : selection;
  return resolveProject(selected.uri.fsPath, projectDirectory, data, tools, choice);
}
