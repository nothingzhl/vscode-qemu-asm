import type { CpuMode } from './x86/state';
export interface MemoryInspectionArgs {
  address?: number | string;
  count?: number;
  follow?: 'address' | 'esp' | 'ebp';
  space?: 'virtual' | 'physical';
}

export interface MemorySnapshot {
  address: number;
  count: number;
  bytes: number[];
  mode: CpuMode;
  follow: 'address' | 'esp' | 'ebp';
  space: 'virtual' | 'physical';
  pagingEnabled: boolean;
  cr3?: number;
  cr4?: number;
  /** Separates histories by address space and paging context. */
  addressContext: string;
  /** Current 4 KiB backing pages; diff histories also key each byte by its page. */
  pageMappings: { virtualPage: number; physicalPage: number }[];
  registers: { esp: number; ebp: number; ss: number; ss_base?: number };
}

export interface DescriptorInspectionArgs {
  table: 'gdt' | 'idt';
  start?: number;
  count?: number;
}

/** Decoded fields are optional because gates, segments and null entries differ. */
export interface DescriptorEntry {
  index: number;
  address: number;
  raw: string;
  kind: string;
  type: string;
  present: boolean;
  dpl: number;
  valid: boolean;
  warnings: string[];
  /** GDT entry identity (index * 8), or the target selector for an IDT/IVT entry. */
  selector?: number;
  /** Only GDT gates need a target distinct from their own selector. */
  targetSelector?: number;
  base?: number;
  rawLimit?: number;
  effectiveLimit?: number;
  granularity?: boolean;
  defaultBits?: 16 | 32;
  code?: boolean;
  readable?: boolean;
  writable?: boolean;
  conforming?: boolean;
  expandDown?: boolean;
  accessed?: boolean;
  available?: boolean;
  longMode?: boolean;
  registers?: string[];
  cacheWarnings?: string[];
  offset?: number;
  gateBits?: 16 | 32;
  parameterCount?: number;
}

export interface DescriptorSnapshot {
  table: 'gdt' | 'idt';
  format: 'gdt' | 'idt' | 'ivt';
  mode: CpuMode;
  base: number;
  limit: number;
  entrySize: 4 | 8;
  totalEntries: number;
  start: number;
  count: number;
  entries: DescriptorEntry[];
  warnings: string[];
}
