/** Compatibility exports for existing integrations; production code uses leaf modules. */
export * from './project/model';
export { resolveProject } from './project/config';
export { createProject } from './project/create';
export { build } from './project/build';
export { parseErrors } from './project/diagnostics';
export { MARKER, example } from './project/templates/boot';
export { PROTECTED_MARKER, protectedBootExample, protectedStageExample } from './project/templates/protected';
export { Processes, execute } from './platform/processes';
export { qemuArguments } from './backends/qemu/arguments';
