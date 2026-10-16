import type { Project } from '../../project/model';

export function qemuArguments(project: Project): string[] {
  // QEMU keyval syntax uses doubled commas for literal filename commas.
  const image = project.image.replace(/,/g, ',,');
  const media = project.boot?.type === 'iso'
    ? ['-boot', 'd', '-drive', `file=${image},format=raw,media=cdrom,readonly=on`]
    : ['-boot', 'a', '-drive', `file=${image},format=raw,if=floppy,readonly=on`];
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
    ...media,
    ...project.qemuArgs
  ];
}
