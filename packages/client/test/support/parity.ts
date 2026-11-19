import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { ManifestValidator, type ManifestValidationOptions } from '@spinajs/validation';
import { buildClientModel, emitZod, type GeneratorDiagnostic } from '../../src/index.js';
import { loadZod, manifestWith, param, route, type SafeParse } from './zod.js';

/**
 * Differential harness: a generated zod schema against the server's `ManifestValidator` on the same input.
 * The rule is one-sided (plan 3.2): zod may be looser than the server where a diagnostic says so, never stricter.
 */
export type Variant = 'request' | 'coerced' | 'reply';

export interface ParityOptions extends ManifestValidationOptions {
  /** Which zod schema to read: `<Dto>Schema`, `<Dto>Coerced` or `<Dto>Reply`. Defaults to `coerced` with `coerce`, else `request`. */
  variant?: Variant;
  /** The zod flavor the file is generated for. */
  mini?: boolean;
  /** The server's verdict on each input, when the caller has them already: asked of the server otherwise. */
  verdicts?: readonly boolean[];
}

export interface Disagreement {
  input: unknown;
  /** What zod parsed it to, when it accepted the input. */
  output?: unknown;
}

export interface ParityResult {
  agree: number;
  /** Inputs the server accepts. */
  accepted: number;
  /** Zod accepts what the server refuses. */
  zodLooser: Disagreement[];
  /** Zod refuses what the server accepts: a bug in the emitter. */
  zodStricter: Disagreement[];
  /** A verdict neither side should give: zod throwing, or the server failing other than by refusing the input. */
  errors: string[];
}

export interface ParitySubject {
  manifest: Manifest;
  mini: boolean;
  /** The schema ids that have a declaration in the generated file. */
  ids: string[];
  diagnostics: GeneratorDiagnostic[];
  server: ManifestValidator;
  module: Record<string, unknown>;
  nameOf(id: string): string;
}

const subjects = new WeakMap<Manifest, Map<boolean, Promise<ParitySubject>>>();

/** Generates and loads `client.zod.ts` for `manifest`, once per flavor. */
export function subjectOf(manifest: Manifest, mini = false): Promise<ParitySubject> {
  let byFlavor = subjects.get(manifest);
  if (!byFlavor) subjects.set(manifest, (byFlavor = new Map()));
  let subject = byFlavor.get(mini);
  if (!subject) {
    subject = (async () => {
      const model = buildClientModel(manifest);
      const { contents, diagnostics } = emitZod(model, { mini, replies: true });
      return { manifest, mini, ids: [...model.ctx.used], diagnostics, server: new ManifestValidator(manifest), module: await loadZod(contents), nameOf: (id: string) => model.ctx.nameOf(id) };
    })();
    byFlavor.set(mini, subject);
  }
  return subject;
}

const exportName = (subject: ParitySubject, id: string, variant: Variant): string => {
  const name = subject.nameOf(id);
  return variant === 'request' ? `${name}Schema` : `${name}${variant === 'coerced' ? 'Coerced' : 'Reply'}`;
};

const variantOf = (options: ParityOptions): Variant => options.variant ?? (options.coerce ? 'coerced' : 'request');

/** The generated schema for `id`, or undefined when the file declares no such variant (only schemas a coerced argument reaches have `Coerced`). */
export function zodSchemaOf(subject: ParitySubject, id: string, variant: Variant): SafeParse | undefined {
  const schema = subject.module[exportName(subject, id, variant)] as SafeParse | undefined;
  return typeof schema?.safeParse === 'function' ? schema : undefined;
}

/** Why the server cannot validate `id` at all, as it refuses the schema: such a schema is outside the comparison. */
export function serverRefusal(subject: ParitySubject, id: string, options: ManifestValidationOptions): string | undefined {
  try {
    subject.server.validator(id, options);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function reachable(manifest: Manifest, id: string): Set<string> {
  const seen = new Set<string>();
  const schemas: Record<string, unknown> = manifest.schemas;
  const visit = (node: unknown, owner: string): void => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, owner));
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const target = value.startsWith('#') ? owner : value.split('#')[0];
        if (!seen.has(target) && target in schemas) {
          seen.add(target);
          visit(schemas[target], target);
        }
      } else visit(value, owner);
    }
  };
  seen.add(id);
  visit(schemas[id], id);
  return seen;
}

/** The diagnostics that explain a looser verdict on `id`: those on the schema itself and on every schema it references. */
export function diagnosticsFor(subject: ParitySubject, id: string): GeneratorDiagnostic[] {
  const closure = reachable(subject.manifest, id);
  return subject.diagnostics.filter((d) => closure.has(d.schema));
}

const relaxed = new WeakMap<Manifest, Map<string, ManifestValidator>>();

/** The server with the keyword a diagnostic names removed: what zod's looser schema is meant to be. */
function without(manifest: Manifest, diagnostics: GeneratorDiagnostic[]): ManifestValidator {
  let byPointer = relaxed.get(manifest);
  if (!byPointer) relaxed.set(manifest, (byPointer = new Map()));
  const key = diagnostics.map((d) => `${d.schema} ${d.pointer}`).join('\n');
  let validator = byPointer.get(key);
  if (!validator) {
    const schemas: Record<string, unknown> = structuredClone(manifest.schemas);
    for (const d of diagnostics) {
      const tokens = d.pointer.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (tokens.length === 0) schemas[d.schema] = true;
      else {
        let node: unknown = schemas[d.schema];
        for (const token of tokens.slice(0, -1)) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[token] : undefined;
        if (typeof node === 'object' && node !== null) delete (node as Record<string, unknown>)[tokens[tokens.length - 1]];
      }
    }
    validator = new ManifestValidator({ ...manifest, schemas });
    byPointer.set(key, validator);
  }
  return validator;
}

/**
 * Whether the keywords that diagnostics name explain zod accepting `input` on `id`: the server accepts it once one of
 * them is removed, or once all are (an input may break two dropped keywords at once). A `ZOD004` is not a dropped
 * keyword, so it explains nothing here.
 */
export function explainedBy(subject: ParitySubject, id: string, options: ManifestValidationOptions, input: unknown): boolean {
  const dropped = diagnosticsFor(subject, id).filter((d) => d.code !== 'ZOD004');
  const accepts = (named: GeneratorDiagnostic[]): boolean => {
    try {
      return serverVerdict({ ...subject, server: without(subject.manifest, named) }, id, options, input);
    } catch {
      // The server without those keywords cannot compile the schema: they explain nothing.
      return false;
    }
  };
  return dropped.length > 0 && (dropped.some((d) => accepts([d])) || (dropped.length > 1 && accepts(dropped)));
}

function removedKeys(input: unknown, output: unknown, into: string[] = []): string[] {
  if (Array.isArray(input) && Array.isArray(output)) input.forEach((item, i) => removedKeys(item, output[i], into));
  else if (typeof input === 'object' && input !== null && typeof output === 'object' && output !== null && !Array.isArray(input) && !Array.isArray(output)) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(output, key)) into.push(key);
      else removedKeys((input as Record<string, unknown>)[key], (output as Record<string, unknown>)[key], into);
    }
  }
  return into;
}

function propertyNames(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => propertyNames(n, into));
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) Object.keys(value).forEach((k) => into.add(k));
      propertyNames(value, into);
    }
  }
  return into;
}

/**
 * Whether a reply that parsed `input` to `output` only dropped keys the schema does not declare, and the server accepts
 * what is left: a reply that forgot a declared property drops that key too, and is not excused.
 */
export function acceptsStripped(subject: ParitySubject, id: string, options: ManifestValidationOptions, input: unknown, output: unknown): boolean {
  const removed = removedKeys(input, output);
  if (removed.length === 0) return false;
  const declared = propertyNames([...reachable(subject.manifest, id)].map((key) => subject.manifest.schemas[key]));
  return removed.every((key) => !declared.has(key)) && serverVerdict(subject, id, options, output);
}

const opened = new WeakMap<Manifest, ManifestValidator>();

// A reply also takes any key next to patternProperties, whatever its additionalProperties schema says.
const openAll = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(openAll);
  if (typeof node !== 'object' || node === null) return node;
  const patterned = 'patternProperties' in node;
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === 'additionalProperties' && (value === false || patterned))).map(([key, value]) => [key, openAll(value)]));
};

/** Whether the server accepts `input` once every closed object is open: a reply's meaning, that it takes the keys a newer server adds. */
export function acceptsOpened(subject: ParitySubject, id: string, options: ManifestValidationOptions, input: unknown): boolean {
  let server = opened.get(subject.manifest);
  if (!server) opened.set(subject.manifest, (server = new ManifestValidator({ ...subject.manifest, schemas: openAll(subject.manifest.schemas) } as Manifest)));
  try {
    return serverVerdict({ ...subject, server }, id, options, input);
  } catch {
    return false;
  }
}

/** The server's verdict; the input is copied, as coercion rewrites it. */
export function serverVerdict(subject: ParitySubject, id: string, options: ManifestValidationOptions, input: unknown): boolean {
  try {
    subject.server.validator(id, options)(structuredClone(input));
    return true;
  } catch (error) {
    if ((error as Error).constructor.name === 'ValidationFailed') return false;
    throw error;
  }
}

/**
 * Runs every input through the generated zod schema for `schemaId` and through the server with `options`, and sorts
 * them into agreement, `zodLooser` (zod accepts, the server refuses) and `zodStricter` (the reverse).
 *
 * Takes a manifest rather than a subject so a caller needs no setup; the generated file is cached per manifest and flavor.
 */
export async function parity(manifest: Manifest, schemaId: string, options: ParityOptions, inputs: Iterable<unknown>): Promise<ParityResult> {
  const subject = await subjectOf(manifest, options.mini === true);
  const variant = variantOf(options);
  const zod = zodSchemaOf(subject, schemaId, variant);
  if (!zod) throw new Error(`${schemaId} has no ${variant} schema in the generated file`);
  const server: ManifestValidationOptions = { coerce: options.coerce, ...(options.openRoot === undefined ? {} : { openRoot: options.openRoot }) };
  const result: ParityResult = { agree: 0, accepted: 0, zodLooser: [], zodStricter: [], errors: [] };
  let index = -1;
  for (const input of inputs) {
    index++;
    let parsed: { success: boolean; data?: unknown };
    let accepts: boolean;
    try {
      parsed = zod.safeParse(input);
    } catch (error) {
      result.errors.push(`zod threw on ${show(input)}: ${(error as Error).message.slice(0, 120)}`);
      continue;
    }
    try {
      accepts = options.verdicts?.[index] ?? serverVerdict(subject, schemaId, server, input);
    } catch (error) {
      result.errors.push(`the server threw on ${show(input)}: ${(error as Error).message.slice(0, 120)}`);
      continue;
    }
    if (accepts) result.accepted++;
    if (parsed.success === accepts) result.agree++;
    else if (parsed.success) result.zodLooser.push({ input, output: parsed.data });
    else result.zodStricter.push({ input });
  }
  return result;
}

export function show(value: unknown): string {
  const text = typeof value === 'number' || value === undefined ? String(value) : JSON.stringify(value);
  const prefix = typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__') ? '[own __proto__] ' : '';
  return prefix + (text.length > 160 ? `${text.slice(0, 160)}...` : text);
}

/**
 * `base` with its controllers replaced by one that sends each named schema as a body and as a query argument, and
 * returns it: so the generated file declares the `Schema`, `Coerced` and `Reply` variant of every name.
 */
export function parityManifest(base: Manifest, named: Record<string, unknown>, extra: Record<string, unknown> = {}): Manifest {
  const ids = Object.keys(named).map((name) => `test/${name}`);
  const queries = ids.map((id, i): RouteEntry => route(`query${i}`, 'get', [param(0, 'q', 'FromQuery', { in: 'query', name: 'q', shape: 'json' }, id, id.slice(5))]));
  const replies = ids.map((id, i): RouteEntry => ({ ...route(`reply${i}`, 'get', []), returnType: { text: id.slice(5), schema: id } }));
  return manifestWith(base, named, extra, [...queries, ...replies]);
}
