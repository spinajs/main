import { createHash } from 'node:crypto';
import { AuthzConfigError, GLOBAL, resourceKey } from '@spinajs/authz';
import type { ResourceRef, RuleDef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { Inject, Injectable } from '@spinajs/di';
import Ajv from 'ajv';

import { RuleStore } from '../contracts.js';

const name = { type: 'string', minLength: 1 };
const names = { type: 'array', items: name, minItems: 1 };
const ref = { type: 'object', properties: { type: name, id: { type: 'string' } }, required: ['type'], additionalProperties: false };
const principalRef = { type: 'object', properties: { type: name, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false };
const valueRef = { type: 'object', properties: { ref: name }, required: ['ref'], additionalProperties: false };
// Conditions are checked by the condition parser, which knows the registered functions.
const condition = { type: 'object' };

const subjects = {
  type: 'object',
  properties: {
    principalTypes: names,
    actorTypes: names,
    refs: { type: 'array', items: principalRef, minItems: 1 },
    rank: {
      type: 'object',
      properties: { ladder: name, at: name, lt: name, eq: name, gte: name },
      required: ['ladder', 'at'],
      oneOf: [{ required: ['lt'] }, { required: ['eq'] }, { required: ['gte'] }],
      additionalProperties: false,
    },
    when: condition,
  },
  additionalProperties: false,
};

const COMMON = { id: name, kind: { enum: ['restrict', 'cap', 'threshold'] }, scope: ref, resourceTypes: names, subjects, when: condition, expiresAt: {}, source: { type: 'string' } };

/** JSON schema (draft-07, AJV 8) of a config RuleDef (design §5.8): closed objects, one key set per kind. */
export const RULE_SCHEMA = deepFreeze({
  $id: 'https://spinajs.com/schemas/authz/rbac-rule.json',
  type: 'object',
  properties: { id: name, kind: { enum: ['restrict', 'cap', 'threshold'] }, scope: ref },
  required: ['id', 'kind', 'scope'],
  allOf: [
    { if: { properties: { kind: { const: 'restrict' } } }, then: { properties: { ...COMMON, allow: { type: 'array', items: { anyOf: [principalRef, { type: 'object', properties: { set: { type: 'object', properties: { role: name, scope: ref }, required: ['role', 'scope'], additionalProperties: false } }, required: ['set'], additionalProperties: false }] } } }, required: ['allow'], additionalProperties: false } },
    {
      if: { properties: { kind: { const: 'cap' } } },
      then: {
        properties: { ...COMMON, ladder: name, maxRole: { anyOf: [name, valueRef, { type: 'null' }] }, stripTags: { type: 'boolean' }, assignments: { type: 'object', properties: { scopeTypes: names, subjectTypes: names }, additionalProperties: false } },
        anyOf: [{ required: ['ladder', 'maxRole'] }, { required: ['stripTags'], properties: { stripTags: { const: true } } }],
        dependencies: { maxRole: ['ladder'] },
        additionalProperties: false,
      },
    },
    {
      if: { properties: { kind: { const: 'threshold' } } },
      then: {
        properties: { ...COMMON, permissions: names, resource: condition, minRole: { anyOf: [name, valueRef] }, ladder: name, at: name, reason: { type: 'object', properties: { code: name, priority: { type: 'number' }, sortKey: { type: 'string' }, model: false }, required: ['code'] } },
        required: ['permissions', 'minRole'],
        dependencies: { at: ['ladder'] },
        additionalProperties: false,
      },
    },
  ],
});

interface AjvError {
  readonly instancePath: string;
  readonly message?: string;
  readonly params: Record<string, unknown>;
}
type Validate = ((v: unknown) => boolean) & { errors?: readonly AjvError[] | null };

let compiled: Validate | undefined;

function validator(): Validate {
  if (compiled) return compiled;
  // ajv's CJS default export is the class itself; under ESM interop it sits on `.default`.
  const AjvClass = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (opts: object) => { compile(schema: object): Validate };
  compiled = new AjvClass({ allErrors: false, strict: false }).compile(RULE_SCHEMA);
  return compiled;
}

/**
 * Reads config rules into frozen RuleDefs.
 * @throws AuthzConfigError naming the rule (index and id) and the path inside it
 */
export function readRuleDefs(rules: unknown, where = 'authz.rbac.rules', source = 'config'): readonly RuleDef[] {
  if (!Array.isArray(rules)) throw new AuthzConfigError(`${where} must be a list of rules`);
  const seen = new Set<string>();
  return Object.freeze(
    rules.map((given: unknown, i) => {
      // Config rules apply at GLOBAL unless they say otherwise (design §5.8; §8.5 writes none).
      const raw = given !== null && typeof given === 'object' && !Array.isArray(given) && (given as { scope?: unknown }).scope === undefined ? { ...given, scope: GLOBAL } : given;
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? ` (id '${(raw as { id: string }).id}')` : '';
      const at = `${where}[${i}]${id}`;
      const validate = validator();
      if (!validate(raw)) {
        const e = validate.errors?.[0];
        const extra = typeof e?.params?.additionalProperty === 'string' ? ` '${e.params.additionalProperty as string}'` : '';
        throw new AuthzConfigError(`${at}${e?.instancePath ? ` at ${e.instancePath}` : ''}: ${e?.message ?? 'is not a valid rule'}${extra}`);
      }
      const r = raw as RuleDef;
      // A bare type is on the path of a list only, never of a check, so lists and checks would disagree.
      if (r.scope.id == null && r.scope.type !== '$global') throw new AuthzConfigError(`${at}: scope must be $global or a node with an id, not the bare type '${r.scope.type}'`);
      if (seen.has(r.id)) throw new AuthzConfigError(`${at}: the id is used by another rule`);
      if (readsResource(r.subjects?.when)) throw new AuthzConfigError(`${at}: subjects.when reads resource.*, but it selects principals before any row is read`);
      if (r.kind !== 'threshold' && readsResource(r.when)) throw new AuthzConfigError(`${at}: its when reads resource.*, which a ${r.kind} rule cannot follow per row (a threshold's resource can)`);
      seen.add(r.id);
      return deepFreeze({ ...r, source: r.source ?? source, ...expiry(r.expiresAt, at) });
    }),
  );
}

/** A condition names `resource.*` in an attr or a ref, function args included (the model's parser says the same at boot). */
function readsResource(c: unknown): boolean {
  if (Array.isArray(c)) return c.some(readsResource);
  if (c === null || typeof c !== 'object') return false;
  return Object.entries(c as Record<string, unknown>).some(([k, x]) => ((k === 'attr' || k === 'ref') && typeof x === 'string' && x.split('.')[0] === 'resource') || readsResource(x));
}

function expiry(value: unknown, at: string): { expiresAt?: Date | null } {
  if (value === undefined || value === null) return value === null ? { expiresAt: null } : {};
  const ms = typeof value === 'string' ? Date.parse(value) : Object.prototype.toString.call(value) === '[object Date]' ? Date.prototype.getTime.call(value) : NaN;
  if (Number.isNaN(ms)) throw new AuthzConfigError(`${at}: expiresAt must be a date or an ISO date string`);
  return { expiresAt: new Date(ms) };
}

/**
 * Rules from config (design §8.2 `authz.rbac.rules`): from the configuration under DI, or from a
 * list (tests, a host that builds the model itself). It checks shapes only; ladders, roles,
 * permissions and conditions are checked by the RBAC model at boot. Registered by its class name;
 * `registerRbacStores` binds it to `RuleStore` when `authz.rbac.stores.rules` names it (the default).
 */
@Injectable()
@Inject(Configuration)
export class ConfigRuleStore extends RuleStore {
  readonly name = 'ConfigRuleStore';
  private loaded?: readonly RuleDef[];
  private hash?: string;

  constructor(private readonly source: Configuration | readonly RuleDef[] = []) {
    super();
  }

  /** Every rule, expired ones included; the model reads them without IO. */
  all(): readonly RuleDef[] {
    this.loaded ??= Array.isArray(this.source) ? readRuleDefs(this.source, 'rules', 'config') : readRuleDefs((this.source as Configuration).get<unknown>(['authz', 'rbac', 'rules'], []));
    return this.loaded;
  }

  /** The rules live at `at` whose scope is one of `path`. */
  rulesOn(path: readonly ResourceRef[], at: Date): readonly RuleDef[] {
    const keys = new Set(path.map(resourceKey));
    return this.all().filter((r) => keys.has(resourceKey(r.scope)) && (r.expiresAt == null || r.expiresAt.getTime() > at.getTime()));
  }

  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    return this.rulesOn(path, at);
  }

  async version(): Promise<string> {
    this.hash ??= createHash('sha256').update(JSON.stringify(this.all())).digest('hex');
    return this.hash;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Date)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
