import type { Project } from '../../project/model';

export function qemuArguments(project: Project): string[] {
  // QEMU keyval syntax uses doubled commas for literal filename commas.
  return [
    '-accel',
    'tcg',
    '-display',
    'none',
    '-monitor',
    'none',
    '-serial',
    'stdio',
    '-nic',
    'none',
    '-no-reboot',
    '-boot',
    'a',
    '-drive',
    `file=${project.image.replace(/,/g, ',,')},format=raw,if=floppy,readonly=on`,
    ...project.qemuArgs
  ];
}
