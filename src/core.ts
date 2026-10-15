/** Compatibility exports for existing integrations; production code uses leaf modules. */
export { qemuArguments } from './backends/qemu/arguments';
export { Processes, execute } from './platform/processes';
export { build } from './project/build';
export { resolveProject } from './project/config';
export { createProject } from './project/create';
export { parseErrors } from './project/diagnostics';
export * from './project/model';
export { MARKER, example } from './project/templates/boot';
export { PROTECTED_MARKER, protectedBootExample, protectedStageExample } from './project/templates/protected';
