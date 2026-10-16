import type { CapabilityRecorder } from '../../ports/machine';
import type { MiClient } from './miClient';
import { miQuote, type MiRecord, type MiTuple, type MiValue } from './miParser';
type Execute = (command: string) => Promise<MiRecord>;
const tuple = (value: MiValue | undefined): MiTuple | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
/** MI transactions own mode switching, contiguous reads and restoration failure. */
export class GdbMemory {
  constructor(
    private readonly requireStopped: () => MiClient,
    private readonly quietly: (execute: Execute, command: string) => Promise<MiRecord>,
    private readonly capabilities: CapabilityRecorder,
    private readonly fail: (error: Error) => void
  ) {}
  async readMemory(address: number, count: number): Promise<Buffer> {
    validateRange(address, count);
    return this.requireStopped().transaction(async (execute) => {
      this.requireStopped();
      const buffers: Buffer[] = [];
      for (let offset = 0; offset < count; offset += 1024) {
        const size = Math.min(1024, count - offset);
        const memory = (await execute(`-data-read-memory-bytes 0x${(address + offset).toString(16)} ${size}`))
          .results.memory;
        if (!Array.isArray(memory)) throw new Error('GDB 返回不完整的内存数据');
        let read = 0;
        for (const raw of memory) {
          const row = tuple(raw);
          if (
            !row ||
            typeof row.begin !== 'string' ||
            Number(row.begin) !== address + offset + read ||
            typeof row.contents !== 'string' ||
            !/^(?:[\da-f]{2})+$/i.test(row.contents)
          )
            throw new Error('GDB 返回不连续的内存数据');
          const buffer = Buffer.from(row.contents, 'hex');
          read += buffer.length;
          buffers.push(buffer);
        }
        if (read !== size) throw new Error('GDB 返回不完整的内存数据');
      }
      return Buffer.concat(buffers);
    });
  }
  async readPhysicalMemory(address: number, count: number): Promise<Buffer> {
    validateRange(address, count);
    return this.requireStopped().transaction(async (execute) => {
      this.requireStopped();
      if (!count) return Buffer.alloc(0);
      const packet = async (payload: string) => {
        const record = await this.quietly(
          execute,
          `-interpreter-exec console ${miQuote(`maintenance packet ${payload}`)}`
        );
        const response = /(?:^|\n)received:\s*"([^"\r\n]*)"/.exec(record.console ?? '');
        if (!response) throw new Error('GDB 没有返回 QEMU 维护包回复');
        return response[1];
      };
      const mode = await packet('qqemu.PhyMemMode');
      if (mode !== '0' && mode !== '1') {
        const error = new Error('当前 QEMU 不支持物理内存读取（qqemu.PhyMemMode）');
        this.capabilities.record('qemu.physicalMemory', {
          state: 'unsupported',
          evidence: 'protocol',
          reason: error.message
        });
        throw error;
      }
      let result: Buffer;
      try {
        try {
          if ((await packet('Qqemu.PhyMemMode:1')) !== 'OK') throw new Error('无法启用 QEMU 物理内存模式');
        } catch (error) {
          this.capabilities.record('qemu.physicalMemory', {
            state: 'unsupported',
            evidence: 'protocol',
            reason: (error as Error).message
          });
          throw error;
        }
        const buffers: Buffer[] = [];
        for (let offset = 0; offset < count; offset += 512) {
          const size = Math.min(512, count - offset);
          const response = await packet(`m${(address + offset).toString(16)},${size.toString(16)}`);
          if (!/^(?:[\da-f]{2})+$/i.test(response) || response.length !== size * 2)
            throw new Error('QEMU 返回不完整的物理内存数据');
          buffers.push(Buffer.from(response, 'hex'));
        }
        result = Buffer.concat(buffers);
      } finally {
        try {
          if ((await packet('Qqemu.PhyMemMode:0')) !== 'OK') throw new Error('QEMU 拒绝恢复虚拟地址模式');
        } catch (error) {
          const failure = new Error(
            `物理内存读取后无法恢复虚拟地址模式，会话已关闭：${(error as Error).message}`
          );
          this.capabilities.record('qemu.physicalMemory', {
            state: 'unsupported',
            evidence: 'protocol',
            reason: failure.message
          });
          this.fail(failure);
          throw failure;
        }
      }
      this.capabilities.record('qemu.physicalMemory', {
        state: 'supported',
        evidence: 'protocol',
        reason: '当前 GDB MI 维护包通道已完成非零物理内存读取并恢复虚拟地址模式',
        details: { bytesRead: result.length }
      });
      return result;
    });
  }
}
function validateRange(address: number, count: number): void {
  if (
    !Number.isSafeInteger(address) ||
    address < 0 ||
    address > 0xffffffff ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 65536 ||
    address + count > 0x100000000
  )
    throw new Error('内存地址必须为 32 位整数，长度为 0..65536 且不能溢出');
}
