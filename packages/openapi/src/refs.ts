// Keys whose children are a name -> schema map, and keywords whose values are plain data: a `$ref` key there is not a reference.
const NAME_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const OPAQUE = new Set(['enum', 'const', 'default', 'examples', 'example']);
const PREFIX = '#/components/schemas/';

function visit(node: unknown, pointer: string, schemas: Record<string, unknown>, inNameMap: boolean): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => visit(item, `${pointer}/${i}`, schemas, false));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (!inNameMap && OPAQUE.has(key)) continue;
    if (!inNameMap && key === '$ref' && typeof value === 'string') {
      if (!value.startsWith(PREFIX) || !Object.hasOwn(schemas, value.slice(PREFIX.length))) throw new Error(`unresolved $ref '${value}' at '${pointer || '/'}'`);
    } else {
      visit(value, `${pointer}/${key}`, schemas, !inNameMap && NAME_MAPS.has(key));
    }
  }
}

/** Asserts every `$ref` in the final document points at an existing `#/components/schemas/<name>`. */
export function validateRefs(document: { components?: { schemas?: Record<string, unknown> } }): void {
  visit(document, '', document.components?.schemas ?? {}, false);
}
