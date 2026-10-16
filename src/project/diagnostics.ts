import * as path from 'node:path';

export function parseErrors(text: string, root: string): { file: string; line: number; message: string }[] {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^(.*?):(\d+):\s*(.*)$/.exec(line);
    return match ? [{ file: path.resolve(root, match[1]), line: Math.max(0, Number(match[2]) - 1), message: match[3] }] : [];
  });
}
