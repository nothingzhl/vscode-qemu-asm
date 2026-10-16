import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkEnvironment, formatEnvironmentReport } from '../../dependencies/doctor';
import type { CapabilityReport } from '../../domain/capabilities';
import type { Processes } from '../../platform/processes';
import { readProject, selectWorkspace } from './projects';

export class DependencyReports {
  private readonly reports = new Map<string, string>();
  private sequence = 0;
  constructor(
    context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runner: Processes,
    private readonly generation: () => number,
    private readonly trusted: () => void,
    private readonly project: typeof readProject = readProject
  ) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('qemu-asm-report', {
        provideTextDocumentContent: (uri) =>
          this.reports.get(uri.toString()) ??
          JSON.stringify(
            {
              status: 'expired',
              reason: '此报告属于已结束的扩展会话，请重新执行依赖报告命令。'
            },
            null,
            2
          )
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === 'qemu-asm-report') this.reports.delete(document.uri.toString());
      })
    );
  }
  async report() {
    const selected = await selectWorkspace();
    let p = await this.project(false, selected);
    try {
      await fs.access(path.join(p.root, 'qemu-asm.json'));
      p = await this.project(true, selected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = this.generation();
    let runtimeReport: CapabilityReport | undefined;
    const session = vscode.debug.activeDebugSession;
    if (session?.type === 'qemu-asm') {
      try {
        runtimeReport = (await session.customRequest('qemuAsm.dependencyReport')) as CapabilityReport;
      } catch (error) {
        this.output.appendLine(`当前会话报告暂不可用：${String(error)}`);
      }
    }
    this.trusted();
    const report = await checkEnvironment(p, this.runner, {
      cancelled: () => token !== this.generation() || !vscode.workspace.isTrusted,
      runtimeReport
    });
    this.output.append(formatEnvironmentReport(report));
    this.output.appendLine(`VS Code 扩展宿主：${vscode.env.remoteName ?? '本地'}；工具在此宿主执行。`);
    return report;
  }

  async check() {
    const report = await this.report();
    void vscode.window.showInformationMessage(
      report.status === 'passed'
        ? '工具解析与版本检查通过；协议能力请查看实际调试会话报告。'
        : '依赖检查发现失败项或已取消，请查看 QEMU Assembly 日志。'
    );
    return report;
  }

  async show() {
    const report = await this.report();
    const uri = vscode.Uri.from({
      scheme: 'qemu-asm-report',
      path: `/dependency-report-${++this.sequence}.json`
    });
    this.reports.set(uri.toString(), JSON.stringify(report, null, 2) + '\n');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'json');
    await vscode.window.showTextDocument(document, { preview: false });
    return report;
  }
}
