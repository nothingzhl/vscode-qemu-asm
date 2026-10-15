import type { RspClient } from '../../debug/rsp';
import type { CapabilityRecorder } from '../../ports/machine';
import { expectOK, validateAddress } from './rspValidation';
export class RspMemory {
  constructor(
    private readonly requireStopped: () => RspClient,
    private readonly capabilities: CapabilityRecorder
  ) {}
  async readMemory(address: number, count: number): Promise<Buffer> {
    const client = this.requireStopped();
    this.validateMemoryRange(address, count);
    return this.readMemoryChunks((payload) => client.command(payload), address, count);
  }
  async readPhysicalMemory(address: number, count: number): Promise<Buffer> {
    const client = this.requireStopped();
    this.validateMemoryRange(address, count);
    if (!count) return Buffer.alloc(0);
    return client.transaction(async (command) => {
      const mode = await command('qqemu.PhyMemMode');
      if (mode !== '0' && mode !== '1') {
        const error = new Error('当前 QEMU 不支持物理内存读取（qqemu.PhyMemMode），请升级 QEMU');
        this.capabilities.record('qemu.physicalMemory', {
          state: 'unsupported',
          evidence: 'protocol',
          reason: error.message
        });
        throw error;
      }
      // 从发送切换请求开始就承担恢复责任，即使它返回错误也不能假定模式未改变。
      let result: Buffer;
      try {
        try {
          expectOK(await command('Qqemu.PhyMemMode:1'), '切换物理内存读取模式');
        } catch (error) {
          this.capabilities.record('qemu.physicalMemory', {
            state: 'unsupported',
            evidence: 'protocol',
            reason: (error as Error).message
          });
          throw error;
        }
        result = await this.readMemoryChunks(command, address, count);
      } finally {
        try {
          expectOK(await command('Qqemu.PhyMemMode:0'), '恢复虚拟内存读取模式');
        } catch (error) {
          this.capabilities.record('qemu.physicalMemory', {
            state: 'unsupported',
            evidence: 'protocol',
            reason: `无法恢复虚拟地址模式：${(error as Error).message}`
          });
          // 不能让后续反汇编、栈或断点请求在未知地址模式下继续执行。
          client.close();
          throw new Error(`物理内存读取后无法恢复虚拟地址模式，调试会话已关闭：${(error as Error).message}`);
        }
      }
      this.capabilities.record('qemu.physicalMemory', {
        state: 'supported',
        evidence: 'protocol',
        reason: '当前 RSP 通道已完成非零物理内存读取并恢复虚拟地址模式',
        details: { bytesRead: result.length }
      });
      return result;
    });
  }
  private validateMemoryRange(address: number, count: number): void {
    validateAddress(address);
    if (!Number.isSafeInteger(count) || count < 0 || count > 65536 || address + count > 0x100000000)
      throw new Error('内存读取长度必须在 0 到 65536 之间且地址不能溢出');
  }
  private async readMemoryChunks(
    command: (payload: string) => Promise<string>,
    address: number,
    count: number
  ): Promise<Buffer> {
    if (!count) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < count; offset += 512) {
      const size = Math.min(512, count - offset);
      const response = await command(`m${(address + offset).toString(16)},${size.toString(16)}`);
      if (!/^(?:[0-9a-f]{2})+$/i.test(response) || response.length !== size * 2)
        throw new Error('QEMU 返回不完整的内存数据');
      chunks.push(Buffer.from(response, 'hex'));
    }
    return Buffer.concat(chunks);
  }
}
