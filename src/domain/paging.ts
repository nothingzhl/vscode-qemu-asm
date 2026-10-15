import type { CpuMode } from './x86/state';
export interface PagingEntry {
  level: 'directory' | 'table';
  index: number;
  /** Physical address of the four-byte entry, not its mapped page. */
  address: number;
  raw: number;
  present: boolean;
  writable: boolean;
  user: boolean;
  writeThrough: boolean;
  cacheDisable: boolean;
  accessed: boolean;
  dirty?: boolean;
  pageSize?: boolean;
  global?: boolean;
  pat?: boolean;
  base?: number;
  reservedBits?: number;
}

export interface PagingPermissions {
  /** PDE and PTE U/S, combined for this mapping. */
  user: boolean;
  /** PDE and PTE R/W, before the supervisor CR0.WP exception. */
  writable: boolean;
  supervisorRead: boolean;
  supervisorWrite: boolean;
  userRead: boolean;
  userWrite: boolean;
}

export interface PagingSnapshot {
  /** Linear (virtual) address, after segmentation. */
  address: number;
  mode: CpuMode;
  pagingEnabled: boolean;
  format: 'disabled' | 'legacy32';
  cr0: number;
  cr3?: number;
  cr4?: number;
  wp: boolean;
  pse: boolean;
  directoryBase?: number;
  directoryIndex: number;
  tableIndex: number;
  offset: number;
  status: 'identity' | 'mapped' | 'not-present' | 'invalid' | 'unsupported';
  physicalAddress?: number;
  pageSize?: 4096 | 4194304;
  faultLevel?: 'directory' | 'table';
  pde?: PagingEntry;
  pte?: PagingEntry;
  effective?: PagingPermissions;
  warnings: string[];
  explanation: string;
}
