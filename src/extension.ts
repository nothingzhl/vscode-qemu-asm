import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qemuAsm.showProjectInfo', async () => {
      await vscode.window.showInformationMessage(
        'QEMU Assembly Toolkit 已启动。当前为项目骨架，计划首先支持 x86 + NASM + QEMU 的构建、运行和调试。'
      );
    })
  );
}
