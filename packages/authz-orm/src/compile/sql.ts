/**
 * SQL text built from typed tokens: literal text comes only from this package's code, column names
 * are rendered by the dialect's identifier quoter against the builder's alias at build time, values
 * are always bindings, and sub-builders (native compilers, scope policies) render through the
 * driver's own where compiler.
 */
export type Token = string | { readonly col: string } | { readonly bind: string | number } | { readonly sub: number };

export class Sql {
  constructor(readonly tokens: readonly Token[]) {}
}

/** Template literal of code-chosen text; every interpolation must already be `Sql`. */
export function sql(strings: TemplateStringsArray, ...parts: readonly Sql[]): Sql {
  const out: Token[] = [];
  strings.forEach((s, i) => {
    if (s !== '') out.push(s);
    if (i < parts.length) out.push(...parts[i].tokens);
  });
  return new Sql(out);
}

/** Code-chosen text only (keywords, a type name, a code constant), never a value from a filter. */
export const raw = (text: string): Sql => new Sql([text]);

export const col = (name: string): Sql => new Sql([{ col: name }]);

export const bind = (value: string | number): Sql => new Sql([{ bind: value }]);

export const subRef = (index: number): Sql => new Sql([{ sub: index }]);

/** A finite number written into the text; anything else would be a value and must be bound. */
export function num(n: number): Sql {
  if (!Number.isFinite(n)) throw new TypeError(`authz-orm: ${n} cannot be written into SQL`);
  return raw(String(n));
}

export function join(parts: readonly Sql[], separator: string): Sql {
  const out: Token[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(separator);
    out.push(...p.tokens);
  });
  return new Sql(out);
}

export const TRUE = raw('(1 = 1)');
export const FALSE = raw('(1 = 0)');
export const UNKNOWN = raw('(NULL = 1)');

export interface RenderEnv {
  column(name: string): string;
  /** Renders sub-builder `index`, pushing its bindings. */
  sub(index: number, bindings: unknown[]): string;
}

export function render(s: Sql, env: RenderEnv): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = [];
  let text = '';
  for (const t of s.tokens) {
    if (typeof t === 'string') text += t;
    else if ('col' in t) text += env.column(t.col);
    else if ('bind' in t) {
      text += '?';
      bindings.push(t.bind);
    } else text += env.sub(t.sub, bindings);
  }
  return { sql: text, bindings };
}
