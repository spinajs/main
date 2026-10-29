import { compile } from 'json-schema-to-typescript';
import type { Manifest } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';

export interface ConfigDeclarationsOptions {
  moduleName?: string;
  /** Restricts the output to these config modules. */
  modules?: string[];
}

export interface ConfigDeclarationsResult {
  source: string;
  warnings: string[];
}

type JsonSchema = Record<string, unknown>;

export function leafPaths(schema: JsonSchema, prefix: string): { path: string; schema: JsonSchema }[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const out: { path: string; schema: JsonSchema }[] = [];
  for (const [name, child] of Object.entries(properties)) {
    if (name === '__file__') continue;
    const path = `${prefix}.${name}`;
    out.push({ path, schema: child });
    if (child.properties) out.push(...leafPaths(child, path));
  }
  return out;
}

const SCHEMA_MAPS = ['properties', 'patternProperties', 'definitions', '$defs'];
const SCHEMA_NESTED = ['allOf', 'anyOf', 'oneOf', 'items', 'additionalProperties', 'not'];

// A titled sub-schema makes the compiler emit a named interface next to `T`; property names such as "title" are kept.
function stripTitles(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripTitles);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'title') continue;
    if (SCHEMA_MAPS.includes(key) && typeof value === 'object' && value !== null) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripTitles(v)]));
    } else {
      out[key] = SCHEMA_NESTED.includes(key) ? stripTitles(value) : value;
    }
  }
  return out;
}

function pointer(base: JsonSchema, fragment: string): unknown {
  let node: unknown = base;
  for (const raw of fragment.split('/').filter((x) => x !== '')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    node = typeof node === 'object' && node !== null ? (node as JsonSchema)[key] : undefined;
  }
  return node;
}

// Refs are inlined from the schema itself or from manifest.schemas: no file system or network access.
function inlineRefs(node: unknown, base: JsonSchema, manifest: Manifest, seen: string[]): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, base, manifest, seen));
  if (typeof node !== 'object' || node === null) return node;
  const obj = node as JsonSchema;
  if (typeof obj.$ref === 'string') {
    const [id, fragment = ''] = obj.$ref.split('#');
    const target = id === '' ? base : (manifest.schemas[id] as JsonSchema | undefined);
    const resolved = target === undefined ? undefined : fragment === '' ? target : pointer(target, fragment);
    if (resolved === undefined) throw new Error(`cannot resolve $ref '${obj.$ref}'`);
    const key = `${id}#${fragment}`;
    if (seen.includes(key)) throw new Error(`recursive $ref '${obj.$ref}'`);
    return inlineRefs(resolved, target ?? base, manifest, [...seen, key]);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, inlineRefs(v, base, manifest, seen)]));
}

async function typeOf(schema: JsonSchema, root: JsonSchema, manifest: Manifest): Promise<string> {
  // $id and $schema would make the compiler resolve them as external references.
  const { $id: _id, $schema: _schema, $configurationModule: _module, ...rest } = schema;
  const input = stripTitles(inlineRefs(rest, root, manifest, [])) as JsonSchema;
  const code = (
    await compile({ ...input, title: 'T' }, 'T', {
      bannerComment: '',
      additionalProperties: false,
      declareExternallyReferenced: false,
      style: { singleQuote: true },
    })
  ).trim();

  const iface = /^export interface T (\{[\s\S]*\})$/.exec(code);
  if (iface) return iface[1].replace(/\s+/g, ' ').replace(/; \}$/, ' }');
  const alias = /^export type T =\s*([\s\S]*?);?$/.exec(code);
  return alias ? alias[1].replace(/\s+/g, ' ').trim() : 'unknown';
}

export async function generateConfigTypes(manifest: Manifest, options: ConfigDeclarationsOptions = {}): Promise<ConfigDeclarationsResult> {
  const moduleName = options.moduleName ?? '@spinajs/configuration-common';
  const warnings: string[] = [];
  for (const requested of options.modules ?? []) {
    if (!manifest.configModules.some((m) => m.module === requested)) warnings.push(`config module '${requested}' is not in the manifest`);
  }
  const modules = manifest.configModules.filter((m) => !options.modules || options.modules.includes(m.module)).sort((a, b) => compareCodeUnits(a.module, b.module));

  const entries: string[] = [];
  const add = async (path: string, schema: JsonSchema, root: JsonSchema): Promise<void> => {
    let type = 'unknown';
    try {
      type = await typeOf(schema, root, manifest);
    } catch (e) {
      warnings.push(`config path '${path}' typed as unknown: ${(e as Error).message.split('\n')[0]}`);
    }
    entries.push(`    '${path}': ${type};`);
  };

  for (const module of modules) {
    const schema = manifest.schemas[module.schemaId] as JsonSchema | undefined;
    if (!schema) {
      warnings.push(`config module '${module.module}' has no schema '${module.schemaId}' in the manifest`);
      continue;
    }
    await add(module.module, schema, schema);
    for (const leaf of leafPaths(schema, module.module)) await add(leaf.path, leaf.schema, schema);
  }

  const source = [
    `/* Generated by spinajs generate:config-types from app.manifest.json (hash ${manifest.hash}). Do not edit. */`,
    `declare module '${moduleName}' {`,
    `  interface ConfigPaths {`,
    ...entries,
    `  }`,
    `}`,
    `export {};`,
    '',
  ].join('\n');
  return { source, warnings };
}

export async function generateConfigDeclarations(manifest: Manifest, options: ConfigDeclarationsOptions = {}): Promise<string> {
  return (await generateConfigTypes(manifest, options)).source;
}
