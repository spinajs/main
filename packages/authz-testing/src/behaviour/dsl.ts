import { GLOBAL, TRUE } from '@spinajs/authz';
import type { Assignment, CombiningAlgorithm, DenyReason, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Value } from '@spinajs/authz';

import type { TestGrantDef, TestRoleDef } from '../arbitraries/rbac.js';
import type { ScriptedVote } from '../fakes/index.js';
import { BEHAVIOUR_RULES } from './rules.js';
import type { BehaviourFixture, BehaviourId, CombineConfig, FixtureExtension, FixturePart, StaticModelSpec } from './types.js';

// Helpers for fixture files; nothing here is engine code.

export const ALGORITHMS: readonly CombiningAlgorithm[] = Object.freeze(['deny-overrides', 'permit-overrides', 'first-applicable'] as const);

export const fixture = (id: BehaviourId, parts: readonly FixturePart[]): BehaviourFixture => ({ id, rule: BEHAVIOUR_RULES[id], parts });

export const extension = (id: BehaviourId, parts: readonly FixturePart[]): FixtureExtension => ({ id, parts });

/** One route for every type. */
export const combine = (algorithm: CombiningAlgorithm, ...models: string[]): CombineConfig => ({ default: { algorithm, models } });

export const staticModel = (name: string, opts: Omit<StaticModelSpec, 'kind' | 'name'> = {}): StaticModelSpec => ({ kind: 'static', name, ...opts });

export const permit = (when: ResourceFilter = TRUE, extra: ScriptedVote = {}): ScriptedVote => ({ permitWhen: when, ...extra });

/** A deny with one `denies` entry carrying `reason`, or a bare `denyWhen` without one. */
export const deny = (reason?: DenyReason, when: ResourceFilter = TRUE, extra: ScriptedVote = {}): ScriptedVote => ({ denyWhen: when, ...(reason ? { denies: [{ when, reason }] } : {}), ...extra });

export const cmp = (field: string, op: Extract<ResourceFilter, { op: 'cmp' }>['cmp'], value?: Value): ResourceFilter => (value === undefined ? { op: 'cmp', field, cmp: op } : { op: 'cmp', field, cmp: op, value });

export const relation = (name: string): ResourceFilter => ({ op: 'relation', relation: name });

export const under = (...scopes: ResourceRef[]): ResourceFilter => ({ op: 'under', scopes });

export const ref = (type: ResourceType, id?: string): ResourceRef => (id === undefined ? { type } : { type, id });

export const later = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

/** A role in the shape of authz-rbac's RoleDef; a string grant is `{ permission }`. */
export const role = (name: string, grants: readonly (string | TestGrantDef)[], extra: Partial<Omit<TestRoleDef, 'name' | 'grants'>> = {}): TestRoleDef => ({
  name,
  extends: [],
  assignable: true,
  source: 'test',
  ...extra,
  grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)),
});

export const assignment = (id: string, subject: PrincipalRef, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Omit<Assignment, 'id' | 'subject' | 'role' | 'scope'>> = {}): Assignment => ({
  id,
  subject: { type: subject.type, id: subject.id },
  role: roleName,
  scope,
  source: 'test',
  ...extra,
});
