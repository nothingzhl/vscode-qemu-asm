import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MachineProfileSelection } from '../../project/machineProfiles';
import type { Project } from '../../project/model';
import { readProject, selectWorkspace } from './projects';

interface SelectionRequest {
  name?: string | null;
  workspaceUri?: string;
}
interface ProfileItem extends vscode.QuickPickItem {
  profile?: string;
  configure?: boolean;
}

/** Remembers one choice per workspace/project; running sessions keep their own configuration. */
export class MachineProfiles {
  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>,
    private readonly trusted: () => void
  ) {}

  async read(readConfig = true, folder?: vscode.WorkspaceFolder, requested?: unknown): Promise<Project> {
    const selected = folder ?? (await selectWorkspace());
    return readProject(readConfig, selected, (base): MachineProfileSelection | undefined => {
      const remembered = this.context.workspaceState.get<string>(this.key(selected, base));
      return requested !== undefined
        ? { name: requested, source: 'launch' }
        : remembered !== undefined
          ? { name: remembered, source: 'selected' }
          : undefined;
    });
  }

  async select(argument?: unknown): Promise<string | undefined> {
    this.trusted();
    const request = this.request(argument);
    const folder = await this.folder(request.workspaceUri);
    const project = await readProject(true, folder);
    const key = this.key(folder, project);
    let name = request.name;
    if (name === undefined) {
      const remembered = this.context.workspaceState.get<string>(key);
      const items: ProfileItem[] = [
        {
          label: '使用项目默认 / 工作区设置',
          description: project.defaultMachineProfile ?? '现有设置',
          picked: remembered === undefined
        },
        ...Object.entries(project.machineProfiles ?? {}).map(([profile, settings]) => ({
          label: profile,
          description: [
            settings.memoryMiB === undefined ? '内存继承设置' : `${settings.memoryMiB} MiB`,
            settings.cpuModel ?? 'CPU 继承设置',
            settings.display === undefined ? '显示器继承设置' : settings.display ? '开启显示器' : '关闭显示器'
          ].join(' · '),
          profile,
          detail:
            profile === remembered
              ? '当前手选方案'
              : profile === project.defaultMachineProfile
                ? '项目默认方案'
                : undefined
        })),
        { label: '配置启动方案…', description: '打开 qemu-asm.json', configure: true }
      ];
      const item = await vscode.window.showQuickPick(items, {
        title: 'QEMU Assembly: 选择启动方案',
        placeHolder: '选择下一次运行或调试使用的方案',
        matchOnDescription: true
      });
      if (!item) return undefined;
      if (item.configure) {
        await this.configure({ workspaceUri: folder.uri.toString() });
        return undefined;
      }
      name = item.profile ?? null;
    }
    this.trusted();
    if (!vscode.workspace.workspaceFolders?.some((item) => item.uri.toString() === folder.uri.toString()))
      throw new Error('工作区已更改，请重新选择启动方案');
    const current = await readProject(false, folder);
    if (this.key(folder, current) !== key) throw new Error('项目目录已更改，请重新选择启动方案');
    // Validate again after user interaction; the config file may have changed while the picker was open.
    const resolved = await readProject(
      true,
      folder,
      name === null ? undefined : { name, source: 'selected' }
    );
    this.trusted();
    if (
      this.key(folder, resolved) !== key ||
      !vscode.workspace.workspaceFolders?.some((item) => item.uri.toString() === folder.uri.toString())
    )
      throw new Error('项目或工作区已更改，请重新选择启动方案');
    await this.context.workspaceState.update(key, name === null ? undefined : name);
    void vscode.window.showInformationMessage(
      `启动方案：${resolved.machineProfile?.name ?? '工作区设置'}。在下一次启动或重启时生效。`
    );
    return name ?? undefined;
  }

  async configure(argument?: unknown): Promise<void> {
    this.trusted();
    const request = this.request(argument);
    const folder = await this.folder(request.workspaceUri);
    const project = await readProject(false, folder);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(project.root, 'qemu-asm.json'))
    );
    this.trusted();
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const match = /"machineProfiles"\s*:/.exec(document.getText());
    if (match) {
      const position = document.positionAt(match.index);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    }
  }

  private key(folder: vscode.WorkspaceFolder, project: Project): string {
    return `qemuAsm.machineProfile:${folder.uri.toString()}:${vscode.Uri.file(project.root).toString()}`;
  }

  private request(argument: unknown): SelectionRequest {
    if (argument === undefined) return {};
    if (!argument || typeof argument !== 'object' || Array.isArray(argument))
      throw new Error('启动方案参数必须是对象');
    const value = argument as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['name', 'workspaceUri'].includes(key)) ||
      (value.name !== undefined && value.name !== null && typeof value.name !== 'string') ||
      (value.workspaceUri !== undefined && typeof value.workspaceUri !== 'string')
    )
      throw new Error('启动方案参数仅支持 name 和 workspaceUri');
    return value as SelectionRequest;
  }

  private async folder(uri?: string): Promise<vscode.WorkspaceFolder> {
    if (uri === undefined) return selectWorkspace();
    const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.toString() === uri);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('找不到指定的文件系统工作区');
    return folder;
  }
}
