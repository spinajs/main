import fc from 'fast-check';

import type { Condition } from '../../src/index.js';

export const FIELDS = ['status', 'owner', 'n', 'team', 'name'] as const;
export const SCALARS: readonly (string | number | boolean)[] = ['a', 'b', 'open', 'release/1', 'x/y', '1', '2', 1, 2, 0, true, false];
export const PRINCIPAL_PATHS = ['principal.id', 'principal.type', 'principal.attributes.pool', 'principal.attributes.n', 'principal.attributes.missing'] as const;
export const ACTOR_PATHS = ['actor.id', 'actor.attributes.team'] as const;
export const ENV_PATHS = ['env.region', 'env.n', 'env.missing'] as const;
export const SCOPE_PATHS = ['scope.org.policies.level', 'scope.org.policies.open', 'scope.$global.flags.on'] as const;
export const FUNCTIONS = ['time.between', 'ip.in', 'glob', 'wildcard'] as const;

const ORDER_OPS = ['lt', 'lte', 'gt', 'gte'] as const;
const PATTERN_OPS = ['like', 'glob', 'wildcard'] as const;
const PATTERNS = ['a', 'a%', '%/1', 'release/*', 'x/**', '*', '_', 'a\\%'];

export interface ConditionArbOptions {
  /** attr roots to draw from; default all. */
  readonly roots?: readonly ('principal' | 'actor' | 'resource' | 'env' | 'scope')[];
  /** allow `{ref}` operands; default true. */
  readonly refs?: boolean;
  /** allow `fn` nodes; default true. */
  readonly functions?: boolean;
  readonly maxDepth?: number;
}

const attrsOf = (root: string): readonly string[] => {
  switch (root) {
    case 'principal':
      return PRINCIPAL_PATHS;
    case 'actor':
      return ACTOR_PATHS;
    case 'env':
      return ENV_PATHS;
    case 'scope':
      return SCOPE_PATHS;
    default:
      return FIELDS.map((f) => `resource.${f}`);
  }
};

/** Conditions drawn from the grammar of design §5.9; every one of them must parse. */
export function condition(opts: ConditionArbOptions = {}): fc.Arbitrary<Condition> {
  const roots = opts.roots ?? ['principal', 'actor', 'resource', 'env', 'scope'];
  const attrs = roots.flatMap(attrsOf);
  const refPool = [...PRINCIPAL_PATHS, ...ACTOR_PATHS, ...ENV_PATHS, ...SCOPE_PATHS].filter((p) => roots.includes(p.split('.')[0] as never));
  const useRefs = (opts.refs ?? true) && refPool.length > 0;
  const ref = fc.constantFrom(...(refPool.length > 0 ? refPool : ['principal.id'])).map((r) => ({ ref: r }));
  const scalar = fc.constantFrom(...SCALARS);
  const operand = (a: fc.Arbitrary<unknown>) => (useRefs ? fc.oneof({ weight: 4, arbitrary: a }, { weight: 1, arbitrary: ref }) : a);
  const attr = fc.constantFrom(...attrs);

  const leaf: fc.Arbitrary<Condition> = fc.oneof(fc.record({ attr, op: fc.constantFrom('eq', 'ne'), v: operand(fc.oneof({ weight: 9, arbitrary: scalar }, { weight: 1, arbitrary: fc.constant(null) })) }), fc.record({ attr, op: fc.constantFrom('in', 'nin'), v: operand(fc.array(fc.constantFrom('a', 'b', 'open', '1', 1, 2), { maxLength: 3 })) }), fc.record({ attr, op: fc.constantFrom(...ORDER_OPS), v: operand(fc.constantFrom(...SCALARS.filter((x) => typeof x !== 'boolean'))) }), fc.record({ attr, op: fc.constantFrom(...PATTERN_OPS), v: operand(fc.constantFrom(...PATTERNS)) }), fc.record({ attr, op: fc.constant('null'), v: fc.boolean() })).map(({ attr: a, op, v }) => ({ attr: a, [op]: v } as Condition));

  const fn: fc.Arbitrary<Condition> = fc.oneof(fc.record({ fn: fc.constant('glob'), args: fc.record({ value: attrsAsRef(attrs), pattern: fc.constantFrom(...PATTERNS) }) }), fc.record({ fn: fc.constant('time.between'), args: fc.record({ from: fc.constant('08:00'), to: fc.constant('18:00') }) })) as fc.Arbitrary<Condition>;

  const base = opts.functions === false ? leaf : fc.oneof({ weight: 6, arbitrary: leaf }, { weight: 1, arbitrary: fn });
  const { tree } = fc.letrec<{ tree: Condition }>((tie) => ({
    tree: fc.oneof(
      { depthSize: 'small', maxDepth: opts.maxDepth ?? 4, withCrossShrink: true },
      base,
      fc.array(tie('tree'), { maxLength: 3 }).map((all) => ({ all })),
      fc.array(tie('tree'), { maxLength: 3 }).map((any) => ({ any })),
      tie('tree').map((c) => ({ not: c })),
    ),
  }));
  return tree;
}

const attrsAsRef = (attrs: readonly string[]): fc.Arbitrary<{ ref: string }> => fc.constantFrom(...attrs).map((a) => ({ ref: a }));
