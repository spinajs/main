import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import type { Decision as EngineDecision } from '@spinajs/authz';

import { fixtureDsl } from '../../src/index.js';
import type { BehaviourAuthz, Case, FixtureExtension } from '../../src/index.js';
import { CAPABILITY_NAMES } from './c6/access.js';
import type { Role } from './c6/access.js';
import { grantedCapabilities } from './c6/authz.js';
import type { Authz, Granted, Principal, Resource } from './c6/authz.js';
import { capabilityPermission, orgLevelPermissions } from './config.js';
import { toDecision, toPermission, toPrincipal, toResourceRef } from './facade.js';
import type { C6FacadeDeps } from './facade.js';
import { loadCanvasFixtures } from './fixtures.js';
import type { CanvasCase, CanvasFixtures } from './fixtures.js';
import type { KnownMismatch } from './conformance.js';
import { CANVAS_CAPABILITIES, canvasWorld } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

/** The 30 permissions in wire order (C6 CAPABILITY_NAMES, the order grantedCapabilities walks). */
export const CANVAS_PERMISSIONS: readonly string[] = Object.freeze(CAPABILITY_NAMES.map(toPermission));

if (CANVAS_PERMISSIONS.join() !== CANVAS_CAPABILITIES.capabilities.map((r) => capabilityPermission(r.name)).join()) {
  throw new Error('canvas c6: CAPABILITY_NAMES and capabilities.json disagree on the wire order');
}

const ORG_PERMISSIONS: ReadonlySet<string> = new Set(orgLevelPermissions(CANVAS_CAPABILITIES));

/** One distinct (principal, resource) of the cases. */
export interface CanvasPair {
  /** Readable and unique: every field of the C6 principal and resource, ids as fixture symbols. */
  readonly key: string;
  readonly principal: Principal;
  readonly resource: Resource;
  /** The cases that ask this pair. */
  readonly cases: readonly CanvasCase[];
}

export function principalLabel(p: Principal, sym: (id: string) => string): string {
  switch (p.kind) {
    case 'user':
      return `user ${sym(p.user)}`;
    case 'group':
      return `group ${sym(p.group)}`;
    case 'link':
      return `link ${sym(p.link)} ${p.user === null ? 'anonymous' : `with user ${sym(p.user)}`}`;
    case 'agent': {
      const files = p.scope.files === null ? '*' : p.scope.files.map(sym).join(',');
      return `agent ${sym(p.session)} task ${sym(p.task)} for ${sym(p.on_behalf_of)} (projects ${p.scope.projects.map(sym).join(',')}; files ${files}; ${p.scope.capabilities.join(',')})`;
    }
  }
}

function resourceLabel(r: Resource, sym: (id: string) => string): string {
  switch (r.kind) {
    case 'org':
      return `org ${sym(r.org)}`;
    case 'project':
      return `project ${sym(r.project)}`;
    case 'file':
      return `file ${sym(r.file)}`;
    case 'branch':
      return `branch ${JSON.stringify(r.branch)} of ${sym(r.project)}/${r.file === null ? '-' : sym(r.file)}`;
  }
}

/** The distinct (principal, resource) pairs of the cases, in first-use order. */
export function canvasPairs(fixtures: Pick<CanvasFixtures, 'symbolOf'>, cases: readonly CanvasCase[]): CanvasPair[] {
  const byKey = new Map<string, { principal: Principal; resource: Resource; cases: CanvasCase[] }>();
  for (const c of cases) {
    const key = `${principalLabel(c.principal, fixtures.symbolOf)} on ${resourceLabel(c.resource, fixtures.symbolOf)}`;
    const hit = byKey.get(key);
    if (hit) hit.cases.push(c);
    else byKey.set(key, { principal: c.principal, resource: c.resource, cases: [c] });
  }
  return [...byKey].map(([key, v]) => ({ key, ...v }));
}

/**
 * The engine decision as compared. `trace` is the only field left out: finish() attaches it only to
 * an explain call (neither path explains) and it carries `durationMs`. Every other field is a function
 * of (principal, permission, ref, the run's instant, the stores): checkMany resolves the ref once and
 * runs the same pipeline per permission, and the kit clock does not move between the two calls, so
 * `validUntil` (ceiling and vote expiry) must agree as well.
 */
export function comparable(d: EngineDecision): Omit<EngineDecision, 'trace'> {
  const { trace: _trace, ...rest } = d;
  return rest;
}

/** grantedCapabilities' walk over the facade, done on the one checkMany answer instead. */
export function grantedFrom(many: ReadonlyMap<string, EngineDecision>): Granted {
  let role: Role = 'none';
  const capabilities: Granted['capabilities'] = [];
  for (const capability of CAPABILITY_NAMES) {
    const permission = toPermission(capability);
    const d = many.get(permission);
    if (!d) continue;
    const c6 = toDecision(d, permission, ORG_PERMISSIONS);
    if (c6.allowed) {
      capabilities.push(capability);
      role = c6.role;
    }
  }
  return { role, capabilities };
}

const json = (v: unknown): string => JSON.stringify(v);

export interface PairAgreement {
  /** One line per disagreeing (pair, permission), plus pair-level lines (key set, grantedCapabilities, B37). */
  readonly lines: readonly string[];
  readonly many: ReadonlyMap<string, EngineDecision>;
}

/**
 * On one loaded system: the pair's principal and ref mapped once with the facade's functions and deps,
 * one checkMany over the 30 permissions, 30 single checks with the same principal object, compared as
 * engine decisions and as the C6 decisions the facade maps; then C6 grantedCapabilities over the facade
 * against the same walk over the checkMany answer, and each case of the pair read from the checkMany
 * answer gives its expected decision (or its pinned known mismatch). Agent pairs also hold B37: checkMany
 * runs as the delegator with the agent as actor, and the ceiling denies every permission outside the
 * agent's profile. `granted: false` skips the grantedCapabilities walk (30 more checks through the facade).
 */
export async function checkManyAgreement(authz: Pick<BehaviourAuthz, 'check' | 'checkMany'>, deps: C6FacadeDeps, facade: Authz, pair: CanvasPair, known: Readonly<Record<string, KnownMismatch>>, opts: { granted?: boolean } = {}): Promise<PairAgreement> {
  const principal = await toPrincipal(pair.principal, deps);
  const resource = toResourceRef(pair.resource);
  const many = await authz.checkMany(principal, CANVAS_PERMISSIONS, resource);
  const lines: string[] = [];
  if ([...many.keys()].join() !== CANVAS_PERMISSIONS.join()) lines.push(`${pair.key}: checkMany answered [${[...many.keys()].join(', ')}], not the 30 permissions in wire order`);

  for (const permission of CANVAS_PERMISSIONS) {
    const single = await authz.check({ principal, permission, resource });
    const batched = many.get(permission);
    if (!batched) continue;
    if (!isDeepStrictEqual(comparable(batched), comparable(single))) lines.push(`${pair.key} ${permission}: engine checkMany ${json(comparable(batched))}, check ${json(comparable(single))}`);
    const c6Batched = toDecision(batched, permission, ORG_PERMISSIONS);
    const c6Single = toDecision(single, permission, ORG_PERMISSIONS);
    if (!isDeepStrictEqual(c6Batched, c6Single)) lines.push(`${pair.key} ${permission}: C6 checkMany ${json(c6Batched)}, check ${json(c6Single)}`);
  }

  if (opts.granted !== false) {
    const viaFacade = await grantedCapabilities(facade, pair.principal, pair.resource);
    const fromMany = grantedFrom(many);
    if (!isDeepStrictEqual(viaFacade, fromMany)) lines.push(`${pair.key}: grantedCapabilities over the facade ${json(viaFacade)}, from checkMany ${json(fromMany)}`);
  }

  for (const c of pair.cases) {
    const permission = toPermission(c.capability);
    const want = Object.hasOwn(known, c.name) ? known[c.name].got : c.expected;
    const d = many.get(permission);
    const got = d ? toDecision(d, permission, ORG_PERMISSIONS) : undefined;
    if (!isDeepStrictEqual(got, want)) lines.push(`${pair.key} ${permission}: case "${c.name}" through checkMany expected ${json(want)}, got ${json(got)}`);
  }

  if (pair.principal.kind === 'agent') {
    const agent = pair.principal;
    const inScope = new Set(agent.scope.capabilities.map(toPermission));
    for (const [permission, d] of many) {
      if (!isDeepStrictEqual(d.principal, { type: 'user', id: agent.on_behalf_of }) || !isDeepStrictEqual(d.actor, { type: 'agent', id: agent.session })) {
        lines.push(`${pair.key} ${permission}: checkMany ran as ${json(d.principal)} with actor ${json(d.actor)}, not as the delegator with the agent as actor`);
      }
      if (!inScope.has(permission) && d.allowed) lines.push(`${pair.key} ${permission}: checkMany allowed a permission outside the agent's profile`);
    }
  }
  return { lines, many };
}

const NOTE = 'K1 task 8: for each distinct (principal, resource) of the 64 canvas cases, one checkMany over the 30 permissions in wire order equals the 30 single checks (engine decisions without trace, and the C6 decisions the facade maps), and C6 grantedCapabilities over the facade equals the same walk over the checkMany answer; agent pairs keep the ceiling and inherit delegation (B37). In memory, one kit case per pair.';

function pairCase(pair: CanvasPair): Case {
  return {
    name: pair.key,
    world: canvasWorld('memory'),
    steps: [
      {
        note: `checkMany agreement for ${pair.cases.length} case(s): ${pair.cases.map((c) => c.name).join('; ')}`,
        async do(ctx) {
          const canvas = ctx.session.lane?.canvas;
          assert.ok(canvas, 'the session has no canvas lane handle');
          assert.ok(ctx.session.authz, 'the session has no authz service');
          const { lines } = await checkManyAgreement(ctx.session.authz, canvas.deps, canvas.facade, pair, KNOWN_MISMATCHES.memory);
          assert.deepStrictEqual(lines, [], lines.join('\n'));
        },
      },
    ],
  };
}

export const CANVAS_PAIRS: readonly CanvasPair[] = Object.freeze(
  (() => {
    const fixtures = loadCanvasFixtures();
    return canvasPairs(fixtures, fixtures.cases);
  })(),
);

export const B40CheckMany: FixtureExtension = fixtureDsl.extension('B40', [{ name: 'checkMany', facets: ['canvas'], lanes: ['K1'], note: NOTE, cases: CANVAS_PAIRS.map(pairCase) }]);
