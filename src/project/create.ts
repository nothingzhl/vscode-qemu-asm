import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { example } from './templates/boot';
import { protectedBootExample, protectedStageExample } from './templates/protected';

export async function createProject(root: string, template: 'boot' | 'protected' = 'boot'): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const created: string[] = [];
  const files: [string, string][] =
    template === 'protected'
      ? [
          ['boot.asm', protectedBootExample],
          ['stage2.asm', protectedStageExample],
          [
            'qemu-asm.json',
            JSON.stringify(
              {
                source: 'boot.asm',
                image: 'build/boot.img',
                stages: [{ source: 'stage2.asm', loadAddress: 0x8000, lba: 1 }]
              },
              null,
              2
            ) + '\n'
          ]
        ]
      : [
          ['boot.asm', example],
          ['qemu-asm.json', JSON.stringify({ source: 'boot.asm', image: 'build/boot.img' }, null, 2) + '\n']
        ];
  try {
    for (const [name, body] of files) {
      const target = path.join(root, name);
      await fs.writeFile(target, body, { flag: 'wx' });
      created.push(target);
    }
  } catch (error) {
    await Promise.all(created.map((p) => fs.unlink(p)));
    throw error;
  }
}
