import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

/** 只读验证文件布局，不将 ELF 内容装入客户机；客户机自己的 loader 负责装载。 */
export async function validateDebugElf(file: string): Promise<void> {
  // O_NONBLOCK 避免把误配置的 FIFO 当作 ELF 时在 open 阶段永久等待。
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 52) throw new Error('C 调试需要有效的 ELF32 文件');
    const read = async (position: number, length: number) => {
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || length > 8 * 1024 * 1024 || position + length > stat.size) throw new Error('ELF 节表范围无效');
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw new Error('ELF 文件读取不完整');
      return buffer;
    };
    const header = await read(0, 52);
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 1 || header[5] !== 1 || header[6] !== 1 || header.readUInt16LE(18) !== 3) throw new Error('C 调试仅支持小端 i386 ELF32，不支持 ELF64 或其他架构');
    if (header.readUInt16LE(16) !== 2) throw new Error('C 调试需要已链接的 ET_EXEC ELF32；暂不支持 PIE/ET_DYN 或未链接的目标文件');
    if (header.readUInt16LE(40) < 52) throw new Error('ELF 文件头无效');
    const sectionOffset = header.readUInt32LE(32);
    const sectionSize = header.readUInt16LE(46);
    const sectionCount = header.readUInt16LE(48);
    const namesIndex = header.readUInt16LE(50);
    if (sectionSize < 40 || sectionSize > 256 || !sectionCount || namesIndex <= 0 || namesIndex >= sectionCount) throw new Error('ELF 缺少可用的调试节表');
    const sections = await read(sectionOffset, sectionSize * sectionCount);
    const namesHeader = sections.subarray(namesIndex * sectionSize);
    const names = await read(namesHeader.readUInt32LE(16), namesHeader.readUInt32LE(20));
    let info = false;
    let line = false;
    for (let index = 0; index < sectionCount; index++) {
      const section = sections.subarray(index * sectionSize);
      const offset = section.readUInt32LE(0);
      if (offset >= names.length) throw new Error('ELF 节名称索引无效');
      const end = names.indexOf(0, offset);
      if (end < 0) throw new Error('ELF 节名称未结束');
      const name = names.toString('utf8', offset, end);
      if (section.readUInt32LE(4) === 8 || !section.readUInt32LE(20)) continue;
      if (section.readUInt32LE(16) + section.readUInt32LE(20) > stat.size) throw new Error('ELF 节范围超出文件');
      if (name === '.debug_info' || name === '.zdebug_info') info = true;
      if (name === '.debug_line' || name === '.zdebug_line') line = true;
    }
    if (!info || !line) throw new Error('ELF 缺少 DWARF 调试信息（.debug_info / .debug_line）；请使用 -g 编译并保留调试节');
  } finally { await handle.close(); }
}
