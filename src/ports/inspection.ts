import type { MemoryReader, PhysicalMemoryReader, RegisterReader } from './machine';
/** A feature boundary can offer virtual inspection without physical-memory support. */
export interface InspectionRuntime extends RegisterReader, MemoryReader {
  readPhysicalMemory?(address: number, count: number): Promise<Buffer>;
}
export interface PagingRuntime extends RegisterReader, PhysicalMemoryReader {}
