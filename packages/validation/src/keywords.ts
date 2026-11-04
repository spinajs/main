import { _, nil, str } from 'ajv';
import type { Code, CodeKeywordDefinition, FuncKeywordDefinition, KeywordCxt, KeywordDefinition, KeywordErrorDefinition, Name } from 'ajv';

/**
 * Deep equality of validated values that never calls a method found on the value itself.
 *
 * Ajv's built-in equal ( fast-deep-equal ) calls `a.valueOf()` and `a.toString()` when they differ from
 * `Object.prototype`'s, so JSON such as `{"valueOf":1}` makes it throw a TypeError. Here a plain object
 * is compared by its own keys; only an object with its own prototype ( a Date, a RegExp ) is compared
 * through that prototype's `valueOf` / `toString`.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  return equalAt(a, b, 0);
}

// Recursion is the fast path; past this depth a subtree is compared by the loop in `equalDeep`, so no depth
// overflows the call stack.
const RECURSION_LIMIT = 1000;

function equalAt(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  if (depth >= RECURSION_LIMIT) return equalDeep(a, b);

  const plan = children(a, b);
  if (typeof plan === 'boolean') return plan;
  const x = a as Record<string | number, unknown>;
  const y = b as Record<string | number, unknown>;
  if (typeof plan === 'number') {
    for (let i = plan; i-- !== 0; ) {
      if (!equalAt(x[i], y[i], depth + 1)) return false;
    }
    return true;
  }
  for (let i = plan.length; i-- !== 0; ) {
    if (!equalAt(x[plan[i]], y[plan[i]], depth + 1)) return false;
  }
  return true;
}

function equalDeep(a: object, b: object): boolean {
  const pending: unknown[] = [];
  if (!comparePair(a, b, 0, pending)) return false;
  while (pending.length !== 0) {
    const depth = pending.pop() as number;
    const y = pending.pop();
    const x = pending.pop();
    if (!comparePair(x, y, depth, pending)) return false;
  }
  return true;
}

// JSON cannot be cyclic; this ends a cyclic value built in code, which would otherwise loop for ever.
const MAX_DEPTH = 100000;

/** False when the pair differs; otherwise pushes its children, as `[x, y, depth]` triples, onto `pending`. */
function comparePair(a: unknown, b: unknown, depth: number, pending: unknown[]): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  if (depth > MAX_DEPTH) throw new RangeError(`jsonEqual: values nested deeper than ${MAX_DEPTH} levels`);

  const plan = children(a, b);
  if (typeof plan === 'boolean') return plan;
  const x = a as Record<string | number, unknown>;
  const y = b as Record<string | number, unknown>;
  if (typeof plan === 'number') {
    for (let i = plan; i-- !== 0; ) pending.push(x[i], y[i], depth + 1);
  } else {
    for (const key of plan) pending.push(x[key], y[key], depth + 1);
  }
  return true;
}

/** The verdict when it is known without looking inside, else the array length or the keys to compare. */
function children(a: object, b: object): boolean | number | string[] {
  const proto = Object.getPrototypeOf(a) as object | null;
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length ? a.length : false;
  if (proto !== null && proto !== Object.prototype) {
    const byPrototype = prototypeEqual(proto, a, b);
    if (byPrototype !== undefined) return byPrototype;
  }

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (let i = keys.length; i-- !== 0; ) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
  }
  return keys;
}

// undefined when the prototype has no comparison of its own and the values are compared by their keys
function prototypeEqual(proto: object, a: object, b: object): boolean | undefined {
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
  const { valueOf, toString } = proto as { valueOf?: unknown; toString?: unknown };
  if (typeof valueOf === 'function' && valueOf !== Object.prototype.valueOf) return valueOf.call(a) === valueOf.call(b);
  if (typeof toString === 'function' && toString !== Object.prototype.toString) return toString.call(a) === toString.call(b);
  return undefined;
}

const pointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

const walkable = (value: unknown): value is object => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

/**
 * The JSON pointers of the non-finite numbers in validated data. JSON carries one only through coercion or a literal
 * such as `1e400`, and a subschema that may fail ( `if`, an `anyOf` / `oneOf` branch, `not` ) coerces in place before
 * it fails, where no `type` rule sees the result. `data` itself is walked whatever its class ( a `@Schema` DTO ); below
 * it plain objects and arrays, as JSON builds them. A loop with a `WeakSet`: no depth or cycle overflows it.
 */
export function findNonFinite(data: unknown, all: boolean): string[] {
  if (typeof data === 'number') return Number.isFinite(data) ? [] : [''];
  if (!data || typeof data !== 'object') return [];

  const found: string[] = [];
  const seen = new WeakSet<object>([data]);
  const pending: [object, string][] = [[data, '']];
  const visit = (child: unknown, path: string) => {
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) found.push(path);
    } else if (walkable(child) && !seen.has(child)) {
      seen.add(child);
      pending.push([child, path]);
    }
  };
  for (let next = 0; next < pending.length && (all || found.length === 0); next++) {
    const [value, path] = pending[next];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], `${path}/${i}`);
    } else {
      for (const key of Object.keys(value)) visit((value as Record<string, unknown>)[key], `${path}/${pointer(key)}`);
    }
  }
  return all ? found : found.slice(0, 1);
}

const useEqual = (cxt: KeywordCxt): Name => cxt.gen.scopeValue('func', { ref: jsonEqual });

/**
 * Set in `params` of the `type` error raised for a non-finite number. A number that was not coerced fails Ajv's
 * own type check too; `DataValidator` drops the marked copy then, and strips the marker otherwise.
 */
export const NON_FINITE_MARK = 'nonFinite';

const typeError: KeywordErrorDefinition = {
  message: ({ schema }) => `must be ${String(schema)}`,
  params: ({ schema, schemaValue }) => _`{type: ${typeof schema == 'string' ? schema : schemaValue}, ${NON_FINITE_MARK}: true}`,
};

const listsNumber = (type: unknown): boolean => {
  const types: unknown[] = Array.isArray(type) ? type : [type];
  return types.includes('number') || types.includes('integer');
};

/**
 * Ajv type-checks before it coerces and never after: `'-Infinity'` coerced for `type: 'number'` is a
 * non-finite number that passes, and `minimum`, `maximum` and `multipleOf` skip it because Ajv runs them
 * on finite numbers only ( `strictNumbers` ). Ajv's own `type` rule has no code ( the core reads the
 * keyword ), so this one runs in its place, after coercion, with the same error.
 */
const finiteNumberType: CodeKeywordDefinition = {
  keyword: 'type',
  schemaType: ['string', 'array'],
  error: typeError,
  code(cxt) {
    if (listsNumber(cxt.schema)) {
      cxt.fail(_`typeof ${cxt.data} == "number" && !isFinite(${cxt.data})`);
    }
  },
};

const constKeyword: CodeKeywordDefinition = {
  keyword: 'const',
  $data: true,
  error: {
    message: 'must be equal to constant',
    params: ({ schemaCode }) => _`{allowedValue: ${schemaCode}}`,
  },
  code(cxt) {
    const { data, $data, schemaCode, schema } = cxt;
    if ($data || (schema && typeof schema == 'object')) {
      cxt.fail$data(_`!${useEqual(cxt)}(${data}, ${schemaCode})`);
    } else {
      cxt.fail(_`${schema} !== ${data}`);
    }
  },
};

const enumKeyword: CodeKeywordDefinition = {
  keyword: 'enum',
  schemaType: 'array',
  $data: true,
  error: {
    message: 'must be equal to one of the allowed values',
    params: ({ schemaCode }) => _`{allowedValues: ${schemaCode}}`,
  },
  code(cxt) {
    const { gen, data, $data, schema, schemaCode, it } = cxt;
    const entries = schema as unknown[];
    if (!$data && entries.length === 0) throw new Error('enum must have non-empty array');

    if ($data || entries.length >= it.opts.loopEnum) {
      const valid = gen.let('valid');
      cxt.block$data(valid, () => {
        const eql = useEqual(cxt);
        gen.assign(valid, false);
        gen.forOf('v', schemaCode as Code, (v) => gen.if(_`${eql}(${data}, ${v})`, () => gen.assign(valid, true).break()));
      });
      cxt.pass(valid);
      return;
    }

    const vSchema = gen.const('vSchema', schemaCode);
    const matches = entries.map((entry, i) => (typeof entry === 'object' && entry !== null ? _`${useEqual(cxt)}(${data}, ${vSchema}[${i}])` : _`${data} === ${entry as string}`));
    cxt.pass(matches.reduce((all, one) => _`${all} || ${one}`));
  },
};

// Ajv's getSchemaTypes: the declared types, plus null for `nullable: true`.
function schemaTypes(schema: unknown): unknown[] {
  if (!schema || typeof schema !== 'object') return [];
  const { type, nullable } = schema as { type?: unknown; nullable?: unknown };
  const types = Array.isArray(type) ? [...type] : type === undefined ? [] : [type];
  if (nullable === true && types.length > 0 && !types.includes('null')) types.push('null');
  return types;
}

function isOfType(t: unknown, item: Name, strictNumbers: boolean): Code {
  const finite = strictNumbers ? _` && isFinite(${item})` : nil;
  switch (t) {
    case 'number':
      return _`(typeof ${item} == "number"${finite})`;
    case 'integer':
      return _`(typeof ${item} == "number" && !(${item} % 1) && !isNaN(${item})${finite})`;
    case 'null':
      return _`${item} === null`;
    default:
      return _`typeof ${item} == ${t as string}`;
  }
}

const uniqueItemsKeyword: CodeKeywordDefinition = {
  keyword: 'uniqueItems',
  type: 'array',
  schemaType: 'boolean',
  $data: true,
  error: {
    message: ({ params: { i, j } }) => str`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
    params: ({ params: { i, j } }) => _`{i: ${i}, j: ${j}}`,
  },
  code(cxt) {
    const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
    if (!$data && !schema) return;
    const valid = gen.let('valid');
    const itemTypes = schemaTypes(parentSchema.items);
    // Primitive items are indexed in one pass; comparing each pair would make a long array a CPU sink.
    const primitives = itemTypes.length > 0 && !itemTypes.some((t) => t === 'object' || t === 'array');

    cxt.block$data(
      valid,
      () => {
        const i = gen.let('i', _`${data}.length`);
        const j = gen.let('j');
        cxt.setParams({ i, j });
        gen.assign(valid, true);
        gen.if(_`${i} > 1`, () => (primitives ? indexed(i, j) : pairwise(i, j)));
      },
      _`${schemaCode} === false`,
    );
    cxt.ok(valid);

    function indexed(i: Name, j: Name): void {
      const item = gen.name('item');
      const matches = itemTypes.map((t) => isOfType(t, item, !!it.opts.strictNumbers)).reduce((all, one) => _`${all} || ${one}`);
      // Ajv's index, on an object without a prototype: on `{}` a "__proto__" item reads Object.prototype. Items of
      // another type are skipped, as Ajv does: `items` already reports them.
      const indices = gen.const('indices', _`Object.create(null)`);
      gen.for(_`;${i}--;`, () => {
        gen.let(item, _`${data}[${i}]`);
        gen.if(_`!(${matches})`, _`continue`);
        if (itemTypes.length > 1) gen.if(_`typeof ${item} == "string"`, _`${item} += "_"`);
        gen
          .if(_`typeof ${indices}[${item}] == "number"`, () => {
            gen.assign(j, _`${indices}[${item}]`);
            cxt.error();
            gen.assign(valid, false).break();
          })
          .code(_`${indices}[${item}] = ${i}`);
      });
    }

    function pairwise(i: Name, j: Name): void {
      const eql = useEqual(cxt);
      const outer = gen.name('outer');
      gen.label(outer).for(_`;${i}--;`, () =>
        gen.for(_`${j} = ${i}; ${j}--;`, () =>
          gen.if(_`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          }),
        ),
      );
    }
  },
};

const SCALAR_TYPES = ['number', 'integer', 'string', 'boolean', 'null'];

// ajv-keywords' uniqueItemProperties with `jsonEqual` in place of fast-deep-equal; the checks are the same.
const uniqueItemPropertiesKeyword: FuncKeywordDefinition = {
  keyword: 'uniqueItemProperties',
  type: 'array',
  schemaType: 'array',
  metaSchema: { type: 'array', items: { type: 'string' } },
  compile(keys: string[], parentSchema) {
    const scalar = keys.map((key) => {
      const t = (parentSchema.items as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties?.[key]?.type;
      return Array.isArray(t) ? !t.includes('object') && !t.includes('array') : SCALAR_TYPES.includes(t as string);
    });

    return (data: unknown[]) => data.length <= 1 || keys.every((key, k) => (scalar[k] ? scalarsUnique(data, key) : valuesUnique(data, key)));
  },
};

function scalarsUnique(data: unknown[], key: string): boolean {
  const seen = new Set<unknown>();
  for (const x of data) {
    if (!x || typeof x != 'object') continue;
    let p = (x as Record<string, unknown>)[key];
    if (p && typeof p == 'object') continue;
    if (typeof p == 'string') p = '"' + p;
    if (seen.has(p)) return false;
    seen.add(p);
  }
  return true;
}

function valuesUnique(data: unknown[], key: string): boolean {
  const values = data.filter((x): x is Record<string, unknown> => !!x && typeof x == 'object').map((x) => x[key]);
  for (let i = values.length; i--; ) {
    for (let j = i; j--; ) {
      if (jsonEqual(values[i], values[j])) return false;
    }
  }
  return true;
}

interface RuleGroup {
  rules: { keyword: string }[];
}

interface KeywordAjv {
  RULES: { rules: RuleGroup[]; post: RuleGroup };
  getKeyword(keyword: string): KeywordDefinition | boolean;
  removeKeyword(keyword: string): unknown;
  addKeyword(definition: KeywordDefinition): unknown;
}

const hasCode = (definition: KeywordDefinition | boolean): boolean =>
  typeof definition === 'object' && ('code' in definition || 'validate' in definition || 'compile' in definition || 'macro' in definition);

// The rule after `keyword` in its group: re-adding before it keeps Ajv's order, and so its verdicts and error order.
function successorOf(ajv: KeywordAjv, keyword: string): string | undefined {
  for (const group of [...ajv.RULES.rules, ajv.RULES.post]) {
    const i = group.rules.findIndex((rule) => rule.keyword === keyword);
    if (i >= 0) return group.rules[i + 1]?.keyword;
  }
  return undefined;
}

function replaceInPlace(ajv: KeywordAjv, definition: CodeKeywordDefinition | FuncKeywordDefinition): void {
  const keyword = definition.keyword as string;
  const before = successorOf(ajv, keyword);
  ajv.removeKeyword(keyword);
  ajv.addKeyword(before === undefined ? definition : { ...definition, before });
}

/**
 * Fails at boot when the Ajv version no longer has the shape these replacements rely on, instead of dropping
 * a real `type` implementation or a keyword silently.
 */
function assertStockShape(ajv: KeywordAjv): void {
  const type = ajv.getKeyword('type');
  if (typeof type !== 'object' || hasCode(type)) {
    throw new Error('@spinajs/validation: Ajv\'s "type" rule is no longer code-less, so the finite-number check cannot replace it');
  }
  for (const keyword of ['const', 'enum', 'uniqueItems']) {
    if (!hasCode(ajv.getKeyword(keyword))) {
      throw new Error(`@spinajs/validation: Ajv has no "${keyword}" keyword implementation to replace`);
    }
  }
}

/**
 * Replaces the keywords that compare values with ones built on `jsonEqual`, and extends `type` to refuse a non-finite
 * number. Each keyword keeps Ajv's rule position. Call it after ajv-keywords: its `uniqueItemProperties` is replaced
 * when present. A non-finite number no `type` rule sees is left to `findNonFinite`.
 */
export function addSafeKeywords(ajv: KeywordAjv): void {
  assertStockShape(ajv);

  for (const definition of [finiteNumberType, constKeyword, enumKeyword, uniqueItemsKeyword, uniqueItemPropertiesKeyword]) {
    if (definition === uniqueItemPropertiesKeyword && !ajv.getKeyword(definition.keyword as string)) continue;
    replaceInPlace(ajv, definition);
  }
}
