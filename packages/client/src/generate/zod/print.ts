import { literal, propertyKey } from '../ts-type.js';

export type Check =
  | { kind: 'refine'; fn: string; message: string }
  | { kind: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
  | { kind: 'maxItems'; value: number }
  | { kind: 'regex'; source: string };

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
    if (node.checks?.length) code = this.mini ? `${code}.check(${node.checks.map((c) => this.miniCheck(c)).join(', ')})` : code + node.checks.map((c) => this.classicCheck(c)).join('');
    if (node.nullable) code = this.mini ? `z.nullable(${code})` : `${code}.nullable()`;
    if (node.description !== undefined) code = this.mini ? `${code}.register(z.globalRegistry, { description: ${literal(node.description)} })` : `${code}.describe(${literal(node.description)})`;
    return code;
  }

  public optional(code: string): string {
    return this.mini ? `z.optional(${code})` : `${code}.optional()`;
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
      const key = p.key === '__proto__' ? `['__proto__']` : propertyKey(p.key);
      const value = p.optional ? this.optional(this.print(p.node, inner)) : this.print(p.node, inner);
      if (p.getter === undefined) return `${inner}${key}: ${value},`;
      return `${inner}get ${key}(): ${this.annotation(p.getter, p.optional)} {\n${inner}  return ${value};\n${inner}},`;
    });
    const object = lines.length ? `z.${CONSTRUCTORS[node.mode]}({\n${lines.join('\n')}\n${indent}})` : `z.${CONSTRUCTORS[node.mode]}({})`;
    if (!node.catchall) return object;
    const rest = this.print(node.catchall, indent);
    return this.mini ? `z.catchall(${object}, ${rest})` : `${object}.catchall(${rest})`;
  }

  private classicCheck(check: Check): string {
    switch (check.kind) {
      case 'refine':
        return `.refine(${check.fn}, ${literal(check.message)})`;
      case 'maxItems':
        return `.max(${check.value})`;
      case 'regex':
        return `.regex(new RegExp(${literal(check.source)}, 'u'))`;
      default:
        return `.${check.kind}(${check.value})`;
    }
  }

  private miniCheck(check: Check): string {
    switch (check.kind) {
      case 'refine':
        return `z.refine(${check.fn}, ${literal(check.message)})`;
      case 'maxItems':
        return `z.maxLength(${check.value})`;
      case 'regex':
        return `z.regex(new RegExp(${literal(check.source)}, 'u'))`;
      default:
        return `z.${check.kind}(${check.value})`;
    }
  }
}
