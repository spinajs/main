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

type Definition = { keyword: string | string[]; macro?: unknown; code?: unknown; validate?: unknown; compile?: unknown };

interface HookedAjv {
  opts: { keywords?: unknown };
  schemas: Record<string, { schema?: unknown } | undefined>;
  RULES: { keywords: Record<string, boolean | undefined> };
  compile(schema: unknown, meta?: boolean): unknown;
  compileAsync(schema: unknown, meta?: boolean): Promise<unknown>;
  addSchema(schema: unknown, key?: string, meta?: boolean, validateSchema?: boolean | 'log'): unknown;
  addKeyword(definition: string | Definition, deprecated?: unknown): unknown;
  removeKeyword(keyword: string): unknown;
  addVocabulary(definitions: Definition[]): unknown;
}

const namesOf = (definition: string | Definition): string[] => [typeof definition === 'string' ? definition : definition.keyword].flat();

/**
 * Installs ajv-merge-patch and ajv-keywords on `ajv` once a schema that names one of their keywords is compiled or added,
 * in the order an eager install used. Each install compiles the keywords' meta-schemas, a large share of a boot whose
 * schemas use none of them.
 *
 * Call it after adding `ajv-formats` and your own keywords. Later, a macro or code keyword, a vocabulary, or a plugin
 * keyword name defined or removed installs the plugins first, as does a schema or keyword given to the Ajv constructor,
 * so a customized instance behaves as with an eager install. A plugin keyword the instance already defines is kept.
 */
export function addKeywordPluginsOnUse<T extends object>(ajv: T): T {
  const target = ajv as unknown as HookedAjv;
  const compile = target.compile.bind(ajv);
  const compileAsync = target.compileAsync.bind(ajv);
  const addSchema = target.addSchema.bind(ajv);
  const addKeyword = target.addKeyword.bind(ajv);
  const removeKeyword = target.removeKeyword.bind(ajv);
  const addVocabulary = target.addVocabulary.bind(ajv);
  const checked = new WeakSet<object>();
  let installed = false;
  let installing = false;

  // Not marked installed until every keyword is in: a failed install is retried, skipping the keywords it already added.
  const install = (): void => {
    if (installed || installing) return;
    installing = true;
    try {
      PLUGINS.forEach((plugin) => plugin(ajv));
      installed = true;
    } finally {
      installing = false;
    }
  };

  const installFor = (schema: unknown): void => {
    if (installed || typeof schema !== 'object' || schema === null || checked.has(schema)) return;
    if (namesAPluginKeyword(schema, keywordsOfPlugins(), new Set())) {
      install();
      return;
    }
    checked.add(schema);
  };

  // `RULES.keywords`, not `getKeyword()`: a keyword defined by name only is in the former and not the latter.
  const defined = (name: string): boolean => target.RULES.keywords[name] === true;

  target.compile = (schema, meta) => {
    installFor(schema);
    return compile(schema, meta);
  };
  target.compileAsync = (schema, meta) => {
    installFor(schema);
    return compileAsync(schema, meta);
  };
  target.addSchema = (schema, key, meta, validateSchema) => {
    [schema].flat().forEach(installFor);
    return addSchema(schema, key, meta, validateSchema);
  };
  target.addKeyword = (definition, deprecated) => {
    if (installing) {
      const missing = namesOf(definition).filter((name) => !defined(name));
      if (missing.length === 0) return ajv;
      if (typeof definition !== 'string' && missing.length < namesOf(definition).length) return addKeyword({ ...definition, keyword: missing });
      return addKeyword(definition, deprecated);
    }
    // A macro or code keyword can expand into a plugin keyword the scan never sees, and any keyword that runs code is
    // evaluated in registration order: installing first keeps the plugin keywords ahead of it, as an eager install did.
    const body = (typeof definition === 'string' ? deprecated : definition) as Partial<Definition> | undefined;
    const runsCode = body?.macro !== undefined || body?.code !== undefined || body?.validate !== undefined || body?.compile !== undefined;
    if (runsCode || namesOf(definition).some((name) => keywordsOfPlugins().has(name))) install();
    return addKeyword(definition, deprecated);
  };
  target.removeKeyword = (keyword) => {
    if (keywordsOfPlugins().has(keyword)) install();
    return removeKeyword(keyword);
  };
  target.addVocabulary = (definitions) => {
    install();
    return addVocabulary(definitions);
  };

  // The constructor adds its `keywords`, `schemas` and `meta` options before this hook exists.
  if (target.opts.keywords !== undefined || Object.values(target.schemas).some((env) => namesAPluginKeyword(env?.schema, keywordsOfPlugins(), new Set()))) {
    install();
  }
  return ajv;
}
