import * as path from 'node:path';
import * as vscode from 'vscode';
import { createProject } from '../../project/create';
import { selectWorkspace as folder } from './projects';
export async function createExample(template: 'boot' | 'protected', trusted: () => void): Promise<void> {
  const selected = await folder();
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: selected.uri,
    openLabel: '在此目录创建示例'
  });
  if (!dirs?.[0]) return;
  if (dirs[0].scheme !== 'file') throw new Error('仅支持本地目录');
  trusted();
  await createProject(dirs[0].fsPath, template);
  const relative = path.relative(selected.uri.fsPath, dirs[0].fsPath) || '.';
  await vscode.workspace
    .getConfiguration('qemuAsm', selected.uri)
    .update('projectDirectory', relative, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.window.showTextDocument(
    vscode.Uri.file(path.join(dirs[0].fsPath, template === 'protected' ? 'stage2.asm' : 'boot.asm'))
  );
  void vscode.window.showInformationMessage(
    template === 'protected'
      ? '二阶段保护模式示例已创建，可设置断点后执行“开始引导调试”。'
      : '引导示例已创建，可执行“构建并运行”。'
  );
}
