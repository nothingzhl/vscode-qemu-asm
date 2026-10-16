/** The DAP envelope shared by request features; bodies remain validated at the feature boundary. */
export interface Request {
  seq: number;
  command: string;
  arguments?: Record<string, unknown>;
}
export type Respond = (request: Request, body?: unknown) => void;
