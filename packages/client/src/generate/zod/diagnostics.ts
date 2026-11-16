/**
 * - `ZOD001`: a schema or `$ref` the generator cannot see or Ajv refuses; that node accepts anything.
 * - `ZOD002`: a format Ajv does not know; the server accepts every value, and so does the schema.
 * - `ZOD003`: a keyword the emitter does not map; it is dropped, so the schema accepts more than the server.
 */
export type GeneratorDiagnosticCode = 'ZOD001' | 'ZOD002' | 'ZOD003';

export interface GeneratorDiagnostic {
  code: GeneratorDiagnosticCode;
  severity: 'warning' | 'error';
  /** Manifest schema id. */
  schema: string;
  /** JSON pointer into that schema. */
  pointer: string;
  message: string;
}

/** Where a schema node sits: the manifest schema it belongs to and its JSON pointer there. */
export interface Location {
  schema: string;
  pointer: string;
}

export function child(at: Location, ...segments: (string | number)[]): Location {
  return { schema: at.schema, pointer: at.pointer + segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('') };
}

export class Diagnostics {
  private readonly found = new Map<string, GeneratorDiagnostic>();

  constructor(private readonly severity: GeneratorDiagnostic['severity']) {}

  public report(code: GeneratorDiagnosticCode, at: Location, message: string): void {
    const key = `${code} ${at.schema} ${at.pointer}`;
    if (!this.found.has(key)) this.found.set(key, { code, severity: this.severity, schema: at.schema, pointer: at.pointer, message });
  }

  public list(): GeneratorDiagnostic[] {
    return [...this.found.values()].sort((a, b) => compare(a.schema, b.schema) || compare(a.pointer, b.pointer) || compare(a.code, b.code));
  }
}

/** Code-unit order: the output must not depend on the generating machine's locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
