import type { FileHandle } from 'node:fs/promises';

/** Bounded ISO9660 / BIOS El Torito checks; firmware still validates and loads the guest. */
export async function validateIso(handle: FileHandle, size: number): Promise<void> {
  const sector = 2048;
  if (size < 20 * sector || size % sector !== 0)
    throw new Error('ISO 镜像必须按 2048 字节对齐并包含 ISO9660 / BIOS El Torito 引导信息');
  const read = async (offset: number, length: number) => {
    if (offset < 0 || offset + length > size) throw new Error('ISO 引导信息超出镜像范围');
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length)
      throw new Error('ISO 引导信息读取不完整');
    return bytes;
  };
  let primary = false;
  let catalog: number | undefined;
  for (let index = 16; index < Math.min(size / sector, 80); index++) {
    const descriptor = await read(index * sector, sector);
    if (descriptor.toString('ascii', 1, 6) !== 'CD001' || descriptor[6] !== 1)
      throw new Error('ISO 缺少有效的 ISO9660 卷描述符');
    if (descriptor[0] === 1) primary = true;
    if (descriptor[0] === 0 && descriptor.toString('ascii', 7, 39).replace(/[\0 ]+$/, '') === 'EL TORITO SPECIFICATION')
      catalog = descriptor.readUInt32LE(71);
    if (descriptor[0] === 255) break;
  }
  if (!primary || catalog === undefined) throw new Error('ISO 需要 ISO9660 和 BIOS El Torito 引导目录');
  const entry = await read(catalog * sector, 64);
  let checksum = 0;
  for (let offset = 0; offset < 32; offset += 2) checksum = (checksum + entry.readUInt16LE(offset)) & 0xffff;
  if (entry[0] !== 1 || entry[1] !== 0 || entry[30] !== 0x55 || entry[31] !== 0xaa || checksum !== 0 || entry[32] !== 0x88)
    throw new Error('ISO 缺少有效的默认 BIOS x86 El Torito 引导项（不支持仅 UEFI 的 ISO）');
}
