import type { Diagnostic, Manifest, ParamEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

interface ObjectSchema {
  $ref?: string;
  properties?: Record<string, unknown>;
}

function propertiesOf(manifest: Manifest, id: string | undefined): Record<string, unknown> | undefined {
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const schema = manifest.schemas[current] as ObjectSchema | undefined;
    if (schema?.properties) return schema.properties;
    current = schema?.$ref;
  }
  return undefined;
}

// `AsDbModel.extract` reads `body[name]` first as well.
const DECORATOR: Record<string, string> = { FromBody: '@Body()', AsDbModel: '@AsModel()' };
const isWholeBody = (p: ParamEntry): boolean => Object.hasOwn(DECORATOR, p.kind) && p.wire?.in === 'body' && p.wire.shape === 'whole';

export const ambiguousBody: DoctorRule = {
  code: 'HTTP005',
  describe: 'A whole-body @Body or @AsModel parameter is not named after a property of its own type',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        for (const p of r.params.filter(isWholeBody)) {
          const properties = propertiesOf(manifest, p.runtimeType.schema);
          if (!properties || !Object.prototype.hasOwnProperty.call(properties, p.name)) continue;
          out.push(
            diagnostic(
              'HTTP005',
              'warning',
              `${c.className}.${r.handler} binds ${DECORATOR[p.kind]} ${p.name} to the whole body, but ${p.runtimeType.text} has a property '${p.name}': a body carrying it binds body.${p.name} instead. Rename the parameter.`,
              r.source,
            ),
          );
        }
      }
    }
    return out;
  },
};
