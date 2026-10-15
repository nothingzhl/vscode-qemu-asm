import * as vscode from 'vscode';
import { InspectorProvider } from '../../inspector/provider';
export function registerInspector(context: vscode.ExtensionContext): void {
  const inspector = new InspectorProvider(context);
  context.subscriptions.push(
    inspector,
    vscode.window.registerWebviewViewProvider('qemuAsm.inspector', inspector, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
      createDebugAdapterTracker: (session) => inspector.createDebugAdapterTracker(session)
    }),
    vscode.commands.registerCommand('qemuAsm.showInspector', () =>
      vscode.commands.executeCommand('qemuAsm.inspector.focus')
    ),
    vscode.commands.registerCommand('qemuAsm.showDisassembly', () => inspector.show('disassembly')),
    vscode.commands.registerCommand('qemuAsm.showDataBreakpoints', () => inspector.show('watchpoints')),
    vscode.commands.registerCommand('qemuAsm.showPaging', () => inspector.show('paging'))
  );
}
