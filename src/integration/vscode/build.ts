import * as vscode from 'vscode';
import type { Processes } from '../../platform/processes';
import { build } from '../../project/build';
import { parseErrors } from '../../project/diagnostics';
import type { Project } from '../../project/model';
export async function compileProject(
  p: Project,
  runner: Processes,
  output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  cancelled: () => boolean
): Promise<void> {
  diagnostics.clear();
  let text = '';
  try {
    await build(
      p,
      runner,
      (chunk) => {
        output.append(chunk);
        text += chunk;
      },
      cancelled
    );
  } finally {
    for (const error of parseErrors(text, p.root)) {
      const uri = vscode.Uri.file(error.file);
      const previous = diagnostics.get(uri) ?? [];
      diagnostics.set(uri, [
        ...previous,
        new vscode.Diagnostic(
          new vscode.Range(error.line, 0, error.line, 1),
          error.message,
          error.message.startsWith('warning:')
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error
        )
      ]);
    }
  }
  output.appendLine(`${p.buildMode === 'existing' ? '已验证现有产物' : '构建成功'}：${p.image}`);
}
