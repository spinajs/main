/**
 * - `ZOD001`: a schema or `$ref` the generator cannot see or Ajv refuses; that node accepts anything.
 * - `ZOD002`: a format Ajv does not know; the server accepts every value, and so does the schema.
 * - `ZOD003`: a keyword the emitter does not map; it is dropped, so the schema accepts more than the server.
 * - `ZOD004`: Ajv coerces a value in place, and a later keyword reads the result; zod reads the value as sent, so a
 *   `Coerced` schema may accept more than the server. Reported only where a coerced variant is generated.
 * - `ZOD005`: the replay of Ajv's coercions is cut: it reaches `PLAN_DEPTH` keyword levels above a coercion, or it would
 *   build itself again through a recursive `$ref`. What reads it is left unchecked (a coerced infinity below is not refused,
 *   a branch or an `if` that depends on it accepts more); it is never stricter. It is also reported on readers that did not
 *   need the cut (any reader of a cut declaration loses its check): it says "may be looser", not "is looser".
 * - `MOCK001`: a schema the mock sampler cannot honour; its mock throws instead of giving data the server rejects.
 * - `MSW001`: a route path MSW cannot express (a parameter name it cannot read); that route gets no handler.
 */
export type GeneratorDiagnosticCode = 'ZOD001' | 'ZOD002' | 'ZOD003' | 'ZOD004' | 'ZOD005' | 'MOCK001' | 'MSW001';

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
