/** Compatibility exports for standalone integrations. */
export { inspectDescriptors } from '../application/inspection/descriptors';
export { inspectMemory } from '../application/inspection/memory';
export { inspectionAddress } from '../application/inspection/requests';
export * from '../domain/inspection';
export { decodeGdtEntry, decodeIdtEntry } from '../domain/x86/descriptors';
export type { InspectionRuntime } from '../ports/inspection';
