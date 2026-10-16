export interface Frame {
  id: number;
  level: number;
  name: string;
  line: number;
  column: number;
  instructionPointerReference?: string;
  source?: { name: string; path: string };
}
export type Handle =
  | { kind: 'locals' | 'arguments' | 'registers' | 'stack' | 'mode'; frame: number }
  | { kind: 'object'; frame: number; object: string; expression?: string };
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  memoryReference?: string;
  indexedVariables?: number;
  namedVariables?: number;
  presentationHint: { attributes: string[] };
}
