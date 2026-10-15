import * as fs from 'node:fs/promises';
import type { DataWatchpoint } from '../../ports/machine';
import type { SourceBinding, SourceBreakpointCommands } from '../../ports/source';
import type { GdbConnection } from './connection';
import { miQuote, MiTuple } from './miParser';
import { address, text, tuple } from './values';

export class GdbSourceBreakpoints implements SourceBreakpointCommands {
  constructor(
    private readonly connection: GdbConnection,
    private readonly elf?: string
  ) {}

  async insertSource(file: string, line: number): Promise<SourceBinding> {
    const reply = await this.connection.mi(`-break-insert -h --source ${miQuote(file)} --line ${line}`);
    return this.binding(tuple(reply.results.bkpt));
  }

  async insertInstruction(at: number): Promise<SourceBinding> {
    return this.insertEntry(`*0x${at.toString(16).toUpperCase().padStart(8, '0')}`);
  }

  async insertEntry(location?: string): Promise<SourceBinding> {
    if (!location) {
      if (!this.elf) throw new Error('源码调试缺少 ELF 入口');
      const file = await fs.open(this.elf, 'r');
      const bytes = Buffer.alloc(52);
      try {
        const result = await file.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead !== bytes.length) throw new Error('ELF 文件头不完整');
      } finally {
        await file.close();
      }
      if (bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 1 || bytes[5] !== 1)
        throw new Error('需要 32 位小端 ELF，或配置明确的 debug.entry');
      location = String(bytes.readUInt32LE(24));
    }
    if (/^(?:0x[0-9a-f]+|\d+)$/i.test(location)) {
      const at = Number(location);
      if (!Number.isSafeInteger(at) || at < 0 || at > 0xffffffff)
        throw new Error('入口地址超出 32 位地址空间');
      location = `*0x${at.toString(16).toUpperCase().padStart(8, '0')}`;
    }
    const reply = await this.connection.mi(`-break-insert -h ${miQuote(location)}`);
    return this.binding(tuple(reply.results.bkpt));
  }

  async insertWatch(point: DataWatchpoint): Promise<SourceBinding> {
    const type = point.size === 1 ? 'unsigned char' : point.size === 2 ? 'unsigned short' : 'unsigned int';
    const option = point.access === 'read' ? '-r ' : point.access === 'readWrite' ? '-a ' : '';
    const expression = `*(${type} *)0x${point.address.toString(16).toUpperCase().padStart(8, '0')}`;
    const result = (await this.connection.mi(`-break-watch ${option}${miQuote(expression)}`)).results;
    return this.binding(tuple(result.wpt ?? result['hw-rwpt'] ?? result['hw-awpt']));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length) await this.connection.mi(`-break-delete ${ids.join(' ')}`);
  }

  private binding(value: MiTuple): SourceBinding {
    return {
      id: text(value.number),
      address: address(value.addr),
      line: Number(text(value.line)) || undefined,
      source: text(value.fullname) || undefined,
      pending: !!text(value.pending)
    };
  }
}
