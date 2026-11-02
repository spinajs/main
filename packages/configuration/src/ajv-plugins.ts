import { default as ajvMergePatch } from 'ajv-merge-patch';
import { default as ajvKeywords } from 'ajv-keywords';

type Plugin = (ajv: unknown) => unknown;
type KeywordDefinition = { keyword: string | string[] };

// CJS modules: the callable may sit on `default` or be the module itself, whatever their types say.
const callable = (mod: unknown): Plugin => ((mod as { default?: Plugin }).default ?? mod) as Plugin;
const PLUGINS = [callable(ajvMergePatch), callable(ajvKeywords)];

let pluginKeywords: ReadonlySet<string> | undefined;

// Read from the plugins themselves, so that a keyword a later version adds is not missed.
function keywordsOfPlugins(): ReadonlySet<string> {
  if (!pluginKeywords) {
    const names = new Set<string>();
    const recorder = {
      addKeyword(definition: KeywordDefinition) {
        [definition.keyword].flat().forEach((name) => names.add(name));
        return recorder;
      },
    };
    PLUGINS.forEach((install) => install(recorder));
    pluginKeywords = names;
  }
  return pluginKeywords;
}

// Every key counts, property names and data included: installing the plugins for nothing is harmless, missing one is not.
function namesAPluginKeyword(value: unknown, keywords: ReadonlySet<string>, seen: Set<object>): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => namesAPluginKeyword(item, keywords, seen));
  return Object.entries(value).some(([key, child]) => keywords.has(key) || namesAPluginKeyword(child, keywords, seen));
}

/**
 * Installs ajv-merge-patch and ajv-keywords on `ajv` once a schema that names one of their keywords is compiled or added,
 * in the order an eager install used. Each install compiles the keywords' meta-schemas, a large share of a boot whose
 * schemas use none of them. Install `ajv-formats` and any keyword of your own on `ajv` directly.
 */
export function addKeywordPluginsOnUse<T extends object>(ajv: T): T {
  type Compile = (schema: unknown, meta?: boolean) => unknown;
  type AddSchema = (schema: unknown, key?: string, meta?: boolean, validateSchema?: boolean | 'log') => unknown;
  const target = ajv as unknown as { compile: Compile; addSchema: AddSchema };
  const compile = target.compile.bind(ajv);
  const addSchema = target.addSchema.bind(ajv);
  const checked = new WeakSet<object>();
  let installed = false;

  const installFor = (schema: unknown): void => {
    if (installed || typeof schema !== 'object' || schema === null || checked.has(schema)) return;
    if (namesAPluginKeyword(schema, keywordsOfPlugins(), new Set())) {
      installed = true;
      PLUGINS.forEach((install) => install(ajv));
      return;
    }
    checked.add(schema);
  };

  target.compile = (schema, meta) => {
    installFor(schema);
    return compile(schema, meta);
  };
  target.addSchema = (schema, key, meta, validateSchema) => {
    [schema].flat().forEach(installFor);
    return addSchema(schema, key, meta, validateSchema);
  };
  return ajv;
}
