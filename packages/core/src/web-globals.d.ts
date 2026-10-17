// The WHATWG `URL` class is a global in every runtime core targets (Node,
// browsers, Bun), but core compiles without DOM or Node types so that neither
// leaks in (ADR-0001). Only the members core reads are declared.
declare class URL {
  constructor(input: string, base?: string);
  readonly origin: string;
  readonly protocol: string;
}
