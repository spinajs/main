import { _, str } from 'ajv';
import type { Code, CodeKeywordDefinition, FuncKeywordDefinition, KeywordCxt, KeywordErrorDefinition, Name } from 'ajv';

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
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return a !== a && b !== b;
  }

  const proto = Object.getPrototypeOf(a) as object | null;
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) return arraysEqual(a, b as unknown[]);
  if (proto !== null && proto !== Object.prototype) {
    const byPrototype = prototypeEqual(proto, a, b);
    if (byPrototype !== undefined) return byPrototype;
  }
  return ownKeysEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = a.length; i-- !== 0; ) {
    if (!jsonEqual(a[i], b[i])) return false;
  }
  return true;
}

// undefined when the prototype has no comparison of its own and the values are compared by their keys
function prototypeEqual(proto: object, a: object, b: object): boolean | undefined {
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
  const { valueOf, toString } = proto as { valueOf?: unknown; toString?: unknown };
  if (typeof valueOf === 'function' && valueOf !== Object.prototype.valueOf) return valueOf.call(a) === valueOf.call(b);
  if (typeof toString === 'function' && toString !== Object.prototype.toString) return toString.call(a) === toString.call(b);
  return undefined;
}

function ownKeysEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
}

const useEqual = (cxt: KeywordCxt): Name => cxt.gen.scopeValue('func', { ref: jsonEqual });

const typeError: KeywordErrorDefinition = {
  message: ({ schema }) => `must be ${String(schema)}`,
  params: ({ schema, schemaValue }) => (typeof schema == 'string' ? _`{type: ${schema}}` : _`{type: ${schemaValue}}`),
};

/**
 * Ajv type-checks before it coerces and never after: `'-Infinity'` coerced for `type: 'number'` is a
 * non-finite number that passes, and `minimum`, `maximum` and `multipleOf` skip it because Ajv runs them
 * on finite numbers only ( `strictNumbers` ). Ajv's own `type` rule has no code ( the core reads the
 * keyword ), so this one runs next to it, after coercion, in the same place and with the same error.
 */
const finiteNumberType: CodeKeywordDefinition = {
  keyword: 'type',
  schemaType: ['string', 'array'],
  error: typeError,
  code(cxt) {
    const types: unknown[] = Array.isArray(cxt.schema) ? cxt.schema : [cxt.schema];
    if (types.includes('number') || types.includes('integer')) {
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
    const { gen, data, $data, schema, schemaCode } = cxt;
    if (!$data && (schema as unknown[]).length === 0) throw new Error('enum must have non-empty array');

    const valid = gen.let('valid');
    cxt.block$data(valid, () => {
      const eql = useEqual(cxt);
      gen.assign(valid, false);
      gen.forOf('v', schemaCode as Code, (v) => gen.if(_`${eql}(${data}, ${v})`, () => gen.assign(valid, true).break()));
    });
    cxt.pass(valid);
  },
};

function schemaTypes(schema: unknown): unknown[] {
  if (!schema || typeof schema !== 'object') return [];
  const { type } = schema as { type?: unknown };
  return Array.isArray(type) ? type : type === undefined ? [] : [type];
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
    const { gen, data, $data, schema, parentSchema, schemaCode } = cxt;
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
      const key = gen.name('key');
      // A Map keyed by type and value: a plain object would read "__proto__" from its prototype.
      const indices = gen.const('indices', _`new Map()`);
      gen.for(_`;${i}--;`, () => {
        gen.let(item, _`${data}[${i}]`);
        gen.if(_`${item} !== null && typeof ${item} == "object"`, _`continue`);
        gen.let(key, _`typeof ${item} + ":" + ${item}`);
        gen
          .if(_`${indices}.has(${key})`, () => {
            gen.assign(j, _`${indices}.get(${key})`);
            cxt.error();
            gen.assign(valid, false).break();
          })
          .code(_`${indices}.set(${key}, ${i})`);
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

// ajv-keywords' uniqueItemProperties with `jsonEqual` in place of fast-deep-equal; the logic is unchanged.
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

interface KeywordAjv {
  getKeyword(keyword: string): unknown;
  removeKeyword(keyword: string): unknown;
  addKeyword(definition: CodeKeywordDefinition | FuncKeywordDefinition): unknown;
}

/**
 * Replaces the keywords that compare values with ones built on `jsonEqual`, and extends `type` to refuse
 * a non-finite number. Call it after ajv-keywords: its `uniqueItemProperties` is replaced when present.
 */
export function addSafeKeywords(ajv: KeywordAjv): void {
  for (const definition of [finiteNumberType, constKeyword, enumKeyword, uniqueItemsKeyword, uniqueItemPropertiesKeyword]) {
    const keyword = definition.keyword as string;
    if (definition === uniqueItemPropertiesKeyword && !ajv.getKeyword(keyword)) continue;
    ajv.removeKeyword(keyword);
    ajv.addKeyword(definition);
  }
}
