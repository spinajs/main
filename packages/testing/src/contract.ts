import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import formats from 'ajv-formats';
import { mergeFragments, readFragment, readManifest } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

// Structural twins of the types @spinajs/http exports: testing does not depend on http.
export interface ContractRoute {
  controller: string;
  handler: string;
}

export interface ContractValidator {
  checkResponse(route: ContractRoute, body: unknown): readonly unknown[] | null;
  checkSchema(schema: object, body: unknown): readonly unknown[] | null;
}

export interface ContractViolation extends ContractRoute {
  kind: 'response' | 'problem';
  status: number;
  errors: readonly unknown[];
}

export class ContractViolationLog {
  public readonly list: ContractViolation[] = [];

  public get count(): number {
    return this.list.length;
  }

  public record(violation: ContractViolation): void {
    this.list.push(violation);
  }

  public describe(): string {
    return this.list.map((v) => `${v.controller}.${v.handler || '(no route)'} ${v.status} ${v.kind}: ${JSON.stringify(v.errors)}`).join('\n');
  }
}

export const CONTRACT_VALIDATOR_KEY = '__http_contract_validator__';
export const CONTRACT_VIOLATIONS_KEY = '__http_contract_violations__';

type Schema = Record<string, unknown>;

// The CJS plugin is callable at runtime, while its types describe the module namespace.
const addFormats = formats as unknown as (ajv: Ajv) => Ajv;

// Keys of these hold schemas by name, so a property called `x-foo` or `$ref` is data, not a keyword.
const NAMED_SCHEMAS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

// Manifest ids are relative and so are the `$ref`s to them; a ref inside a schema that has an `$id` would resolve against it.
const BASE = 'https://manifest.spinajs.invalid/';

function prepare(value: unknown, ids: ReadonlySet<string>, named = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => prepare(item, ids));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const copy: Schema = {};
  for (const [key, child] of Object.entries(value)) {
    if (!named && key.startsWith('x-')) {
      continue;
    }
    const isRef = !named && key === '$ref' && typeof child === 'string';
    copy[key] = isRef && ids.has(child.split('#')[0]) ? BASE + child : prepare(child, ids, !named && NAMED_SCHEMAS.has(key));
  }
  return copy;
}

/** Copies a schema without the `x-*` extension keywords the compiler adds (`x-derived`, `x-explicit`, ...). */
export function stripExtensions(value: unknown): unknown {
  return prepare(value, new Set());
}

/**
 * Checks response bodies against the schemas the compiler derived for each route's return type.
 * An `x-explicit: 'partial'` schema is documentation only (the runtime `@Schema` is authoritative), so it accepts
 * anything. A controller or route the manifest does not know is not checked.
 */
export function manifestContractValidator(manifest: Manifest): ContractValidator {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  const ids = new Set(Object.keys(manifest.schemas));
  for (const [id, schema] of Object.entries(manifest.schemas)) {
    const partial = (schema as Schema)['x-explicit'] === 'partial';
    ajv.addSchema(partial ? {} : { ...(prepare(schema, ids) as Schema), $id: BASE + id }, BASE + id);
  }

  const schemaOf = (route: ContractRoute): string | undefined =>
    manifest.controllers.filter((c) => c.className === route.controller).flatMap((c) => c.routes).find((r) => r.handler === route.handler)?.returnType.schema;

  const run = (validate: ValidateFunction, body: unknown): readonly ErrorObject[] | null => (validate(body) ? null : (validate.errors ?? []));

  return {
    checkResponse(route, body) {
      const id = schemaOf(route);
      if (!id) {
        return null;
      }
      const validate = ajv.getSchema(BASE + id);
      return validate ? run(validate, body) : [{ message: `schema ${id} of ${route.controller}.${route.handler} is not in the manifest` }];
    },
    checkSchema(schema, body) {
      const id = (schema as Schema).$id;
      const validate = (typeof id === 'string' ? ajv.getSchema(id) : undefined) ?? ajv.compile(schema);
      return run(validate, body);
    },
  };
}

export interface ContractTestingOptions {
  /** The manifest whose derived schemas the responses must match, or the path of one. Default `app.manifest.json` in the working directory. */
  manifest?: Manifest | string;
  /** 'throw' (default): a body that breaks its schema answers 500. 'log': it is only recorded. `assertClean()` fails either way. */
  mode?: 'throw' | 'log';
}

export interface ContractTestingHandle {
  readonly violations: ContractViolationLog;
  /** Registers the validator and the violation log; before the app resolves anything. */
  register(container: IContainer): void;
  /** Switches `http.contractTesting` on in a resolved configuration. */
  enable(configuration: Configuration): void;
  /** Throws when a response broke its contract. */
  assertClean(): void;
}

/** The parts of contract testing for apps that boot without createTestApp: register, enable, run, assertClean. */
export async function installContractTesting(options: true | ContractTestingOptions): Promise<ContractTestingHandle> {
  const settings = options === true ? {} : options;
  const source = settings.manifest ?? 'app.manifest.json';
  const manifest = typeof source === 'string' ? await readManifest(source) : source;
  const validator = manifestContractValidator(manifest);
  const violations = new ContractViolationLog();

  return {
    violations,
    register(container) {
      container.register(validator).asValue(CONTRACT_VALIDATOR_KEY);
      container.register(violations).asValue(CONTRACT_VIOLATIONS_KEY);
    },
    enable(configuration) {
      configuration.set('http.contractTesting', { enabled: true, mode: settings.mode ?? 'throw' });
    },
    assertClean() {
      if (violations.count > 0) {
        throw new Error(`${violations.count} response(s) broke their contract
${violations.describe()}`);
      }
    },
  };
}

/** One manifest from the built `manifest.fragment.json` of each package, for apps without an `app.manifest.json`. */
export async function manifestOfFragments(fragmentFiles: readonly string[]): Promise<Manifest> {
  const [app, ...deps] = await Promise.all(fragmentFiles.map((file) => readFragment(file)));
  if (!app) {
    throw new Error('manifestOfFragments: no fragment given');
  }
  return mergeFragments(app, deps, { app: { name: app.package.name, version: app.package.version, root: '.', outDir: app.package.outDir }, packages: [] });
}
