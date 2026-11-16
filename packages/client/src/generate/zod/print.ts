import { literal, propertyKey } from '../ts-type.js';

export type Check =
  | {
      kind: 'refine';
      fn: string;
      message: string;
      /** Schemas `fn` reads, written into it at `use(i)`: a hoisted const, or the schema itself inside a getter. */
      uses?: ZodNode[];
      /** Where the issue is reported, below the checked value: a `$data` check on the parent reports at the property. */
      path?: string[];
      /** Set for `additionalProperties: false` next to `patternProperties`, which an opened root drops. */
      closes?: boolean;
    }
  | { kind: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
  | { kind: 'maxItems'; value: number }
  | { kind: 'regex'; source: string; flags?: string };

export type Arg = { code: string } | { node: ZodNode } | { list: ZodNode[] } | { lazy: string };

export interface Property {
  key: string;
  node: ZodNode;
  optional: boolean;
  /** Set for a property read through a getter: the TypeScript type of its value, which the getter is annotated with. */
  getter?: string;
}

interface Modifiers {
  checks?: Check[];
  nullable?: boolean;
  description?: string;
  /** zod 4.1 passes a missing key whose schema accepts `undefined`; such a required key needs its own check. */
  acceptsUndefined?: boolean;
  /** Checks of the value as sent, before the schema parses it: zod's output drops an own `__proto__` key, Ajv does not. */
  inputChecks?: Check[];
  /** A function the value goes through first: Ajv's type coercion, or an ajv-keywords `transform`. Outermost first. */
  before?: string[];
}

export type ZodNode = Modifiers &
  (
    | { kind: 'call'; fn: string; args?: Arg[]; typeArg?: string; helper?: boolean }
    | { kind: 'ref'; name: string }
    | { kind: 'object'; mode: 'strict' | 'loose' | 'strip'; properties: Property[]; catchall?: ZodNode }
    | { kind: 'shape'; mode: 'loose' | 'strip'; of: string }
  );

export const call = (fn: string, ...args: Arg[]): ZodNode => ({ kind: 'call', fn, args });

export const UNKNOWN: ZodNode = { kind: 'call', fn: 'unknown', acceptsUndefined: true };

// A `__proto__` key in an object literal sets the prototype instead of defining a property.
export function valueCode(value: unknown): string {
  const json = JSON.stringify(value);
  return json.includes('"__proto__"') ? `JSON.parse(${literal(json)})` : json;
}

/** A key of an object literal; `__proto__` there would set the prototype instead. */
export const objectKey = (key: string): string => (key === '__proto__' ? `['__proto__']` : propertyKey(key));

/** The placeholder of `uses[i]` in a refine's `fn`: private-use characters, which no printed code contains. */
export const use = (i: number): string => `${i}`;

/** A declaration `z.looseObject(X.shape)` can open: a strict object and nothing around it. */
export function isPlainObject(node: ZodNode): boolean {
  return node.kind === 'object' && node.mode === 'strict' && !node.checks?.length && !node.inputChecks?.length && !node.before?.length && !node.nullable;
}

const opens = (checks: Check[] | undefined): Check[] | undefined => checks?.filter((c) => c.kind !== 'refine' || !c.closes);

/**
 * Opens the closed object of a node, and of each part of an intersection, as the server opens a schema's root. An object
 * with checks stays loose instead of stripping, because the checks read the parsed value: a required key the root does
 * not declare must still be there.
 */
export function reopen(node: ZodNode, mode: 'strip' | 'loose'): ZodNode {
  if (node.kind === 'object') {
    const opened: ZodNode = { ...node, checks: opens(node.checks), inputChecks: opens(node.inputChecks) };
    return node.mode === 'strict' ? { ...opened, mode: node.checks?.length || node.inputChecks?.length ? 'loose' : mode } : opened;
  }
  if (node.kind !== 'call' || node.fn !== 'intersection') return node;
  return { ...node, args: (node.args ?? []).map((a) => ('node' in a ? { node: reopen(a.node, mode) } : a)) };
}

/** Every node a node prints, its own included: for the type names they use. */
export function nodesIn(node: ZodNode): ZodNode[] {
  const found: ZodNode[] = [];
  const walk = (n: ZodNode): void => {
    found.push(n);
    for (const check of [...(n.checks ?? []), ...(n.inputChecks ?? [])]) if (check.kind === 'refine') check.uses?.forEach(walk);
    if (n.kind === 'call') {
      for (const arg of n.args ?? []) {
        if ('node' in arg) walk(arg.node);
        if ('list' in arg) arg.list.forEach(walk);
      }
    }
    if (n.kind === 'object') {
      n.properties.forEach((p) => walk(p.node));
      if (n.catchall) walk(n.catchall);
    }
  };
  walk(node);
  return found;
}

const CONSTRUCTORS = { strict: 'strictObject', loose: 'looseObject', strip: 'object' } as const;

/** Prints the emitter's nodes as classic `zod` (method chains) or `zod/mini` (functions and `.check()`). */
export class Printer {
  constructor(public readonly mini: boolean) {}

  public get typeName(): string {
    return this.mini ? 'z.ZodMiniType' : 'z.ZodType';
  }

  /** The type a getter returns: the schema of a value of TypeScript type `type`. */
  public annotation(type: string, optional: boolean): string {
    const schema = `${this.typeName}<${type}>`;
    if (!optional) return schema;
    return this.mini ? `z.ZodMiniOptional<${schema}>` : `z.ZodOptional<${schema}>`;
  }

  public print(node: ZodNode, indent = ''): string {
    let code = this.base(node, indent);
    if (node.checks?.length) code = this.checked(code, node.checks, indent);
    if (node.nullable) code = this.nullable(code);
    if (node.inputChecks?.length) {
      const input = this.checked('z.unknown()', node.inputChecks, indent);
      code = this.mini ? `z.pipe(${input}, ${code})` : `${input}.pipe(${code})`;
    }
    for (const fn of [...(node.before ?? [])].reverse()) code = this.before(fn, code);
    if (node.description !== undefined) {
      const text = literal(node.description);
      code = this.mini ? `${code}.register(z.globalRegistry, { description: ${text} })` : `${code}.describe(${text})`;
    }
    return code;
  }

  public optional(code: string): string {
    return this.mini ? `z.optional(${code})` : `${code}.optional()`;
  }

  public nullable(code: string): string {
    return this.mini ? `z.nullable(${code})` : `${code}.nullable()`;
  }

  /** `code` after the value went through `fn`. */
  public before(fn: string, code: string): string {
    return this.mini ? `z.pipe(z.transform(${fn}), ${code})` : `z.preprocess(${fn}, ${code})`;
  }

  private checked(code: string, checks: Check[], indent: string): string {
    return this.mini ? `${code}.check(${checks.map((c) => this.miniCheck(c, indent)).join(', ')})` : code + checks.map((c) => this.classicCheck(c, indent)).join('');
  }

  private base(node: ZodNode, indent: string): string {
    switch (node.kind) {
      case 'ref':
        return node.name;
      case 'shape':
        return `z.${CONSTRUCTORS[node.mode]}(${node.of}.shape)`;
      case 'object':
        return this.object(node, indent);
      case 'call':
        return `${node.helper ? '' : 'z.'}${node.fn}${node.typeArg ? `<${node.typeArg}>` : ''}(${(node.args ?? []).map((a) => this.arg(a, indent)).join(', ')})`;
    }
  }

  private arg(arg: Arg, indent: string): string {
    if ('code' in arg) return arg.code;
    if ('node' in arg) return this.print(arg.node, indent);
    if ('lazy' in arg) return `() => ${arg.lazy}`;
    return `[${arg.list.map((n) => this.print(n, indent)).join(', ')}]`;
  }

  private object(node: Extract<ZodNode, { kind: 'object' }>, indent: string): string {
    const inner = `${indent}  `;
    const lines = node.properties.map((p) => {
      const key = objectKey(p.key);
      const value = p.optional ? this.optional(this.print(p.node, inner)) : this.print(p.node, inner);
      if (p.getter === undefined) return `${inner}${key}: ${value},`;
      return `${inner}get ${key}(): ${this.annotation(p.getter, p.optional)} {\n${inner}  return ${value};\n${inner}},`;
    });
    const object = lines.length ? `z.${CONSTRUCTORS[node.mode]}({\n${lines.join('\n')}\n${indent}})` : `z.${CONSTRUCTORS[node.mode]}({})`;
    if (!node.catchall) return object;
    const rest = this.print(node.catchall, indent);
    return this.mini ? `z.catchall(${object}, ${rest})` : `${object}.catchall(${rest})`;
  }

  private refine(check: Extract<Check, { kind: 'refine' }>, indent: string): string {
    const fn = check.fn.replace(/(\d+)/g, (_m, i: string) => this.print(check.uses![Number(i)], indent));
    const options = check.path ? `{ message: ${literal(check.message)}, path: [${check.path.map(literal).join(', ')}] }` : literal(check.message);
    return `${fn}, ${options}`;
  }

  private regex(check: Extract<Check, { kind: 'regex' }>): string {
    return `new RegExp(${literal(check.source)}, ${literal(check.flags ?? 'u')})`;
  }

  private classicCheck(check: Check, indent: string): string {
    switch (check.kind) {
      case 'refine':
        return `.refine(${this.refine(check, indent)})`;
      case 'maxItems':
        return `.max(${check.value})`;
      case 'regex':
        return `.regex(${this.regex(check)})`;
      default:
        return `.${check.kind}(${check.value})`;
    }
  }

  private miniCheck(check: Check, indent: string): string {
    switch (check.kind) {
      case 'refine':
        return `z.refine(${this.refine(check, indent)})`;
      case 'maxItems':
        return `z.maxLength(${check.value})`;
      case 'regex':
        return `z.regex(${this.regex(check)})`;
      default:
        return `z.${check.kind}(${check.value})`;
    }
  }
}
