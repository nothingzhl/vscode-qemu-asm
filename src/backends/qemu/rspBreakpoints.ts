import type { DataWatchpoint } from '../../ports/machine';
import type { RspClient } from '../rsp/client';
import { expectOK, validateAddress } from './rspValidation';
export class RspBreakpoints {
  readonly breakpoints = new Set<number>();
  private dataBreakpoints = new Map<string, DataWatchpoint>();
  constructor(
    private readonly requireStopped: () => RspClient,
    private readonly fail: (error: Error) => Promise<void>
  ) {}
  async setBreakpoints(addresses: number[]): Promise<void> {
    const client = this.requireStopped();
    for (const address of addresses) validateAddress(address);
    const desired = new Set(addresses);
    const previous = new Set(this.breakpoints);
    const update = async (target: Set<number>) => {
      for (const address of this.breakpoints) {
        if (target.has(address)) continue;
        expectOK(await client.command(`z1,${address.toString(16)},1`), '移除硬件断点');
        this.breakpoints.delete(address);
      }
      for (const address of target) {
        if (this.breakpoints.has(address)) continue;
        expectOK(await client.command(`Z1,${address.toString(16)},1`), '设置硬件断点');
        this.breakpoints.add(address);
      }
    };
    try {
      await update(desired);
    } catch (error) {
      try {
        await update(previous);
      } catch (rollback) {
        const failure = new Error(`硬件断点设置失败且无法恢复旧设置：${(rollback as Error).message}`);
        await this.fail(failure);
        throw failure;
      }
      throw error;
    }
  }
  async setDataBreakpoints(points: DataWatchpoint[]): Promise<void> {
    const client = this.requireStopped();
    if (points.length > 16) throw new Error('最多同时设置 16 个数据断点');
    const desired = new Map<string, DataWatchpoint>();
    for (const point of points) {
      validateAddress(point.address);
      if (![1, 2, 4].includes(point.size) || point.address + point.size > 0x100000000)
        throw new Error('数据断点长度必须是 1、2 或 4 字节且地址不能溢出');
      if (!['read', 'write', 'readWrite'].includes(point.access))
        throw new Error('数据断点访问类型必须是 read、write 或 readWrite');
      const copy = { ...point };
      desired.set(watchKey(copy), copy);
    }
    const previous = new Map(this.dataBreakpoints);
    const update = async (target: Map<string, DataWatchpoint>) => {
      for (const [key, point] of this.dataBreakpoints) {
        if (target.has(key)) continue;
        expectOK(await client.command(watchCommand(point, false)), '移除数据断点');
        this.dataBreakpoints.delete(key);
      }
      for (const [key, point] of target) {
        if (this.dataBreakpoints.has(key)) continue;
        expectOK(await client.command(watchCommand(point, true)), '设置数据断点');
        this.dataBreakpoints.set(key, point);
      }
    };
    try {
      await update(desired);
    } catch (error) {
      try {
        await update(previous);
      } catch (rollback) {
        const failure = new Error(`数据断点设置失败且无法恢复旧设置：${(rollback as Error).message}`);
        await this.fail(failure);
        throw failure;
      }
      throw error;
    }
  }
}
function watchKey(point: DataWatchpoint): string {
  return `${point.access}:${point.address}:${point.size}`;
}
function watchCommand(point: DataWatchpoint, insert: boolean): string {
  const type = { write: 2, read: 3, readWrite: 4 }[point.access];
  return `${insert ? 'Z' : 'z'}${type},${point.address.toString(16)},${point.size.toString(16)}`;
}
