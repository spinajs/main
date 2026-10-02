import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { Step, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const PERMITS = { votes: { 'file:read': permit() } };

const base = (extra: Partial<World>): World => ({ permissions: ['file:read'], principals: { alice }, combine: combine('deny-overrides', 'm1'), models: [staticModel('m1')], ...extra });

const check = (allowed: boolean, domain?: string): Step => ({ check: { as: 'alice', permission: 'file:read', resource: f1, ...(domain ? { domain } : {}) }, expect: { allowed } });

export const B29 = fixture('B29', [
  {
    name: 'host',
    facets: ['engine', 'host'],
    lanes: ['F4'],
    cases: [
      {
        name: 'a child domain adds its own model; the parent never sees it',
        world: base({ domains: { fs: { models: [staticModel('m3', PERMITS)], combine: combine('deny-overrides', 'm1', 'm3') } } }),
        steps: [check(true, 'fs'), check(false), { calls: { model: 'm3', domain: 'fs', count: 1 } }, { models: ['m1'] }, { models: ['m1', 'm3'], domain: 'fs' }],
      },
      {
        name: "a child model with a parent model's name replaces it in the child only",
        world: base({ domains: { fs: { models: [staticModel('m1', PERMITS)] } } }),
        steps: [check(true, 'fs'), check(false), { calls: { model: 'm1', count: 1 } }, { calls: { model: 'm1', domain: 'fs', count: 1 } }, { models: ['m1'], domain: 'fs' }],
      },
      {
        name: 'disable removes a parent model from the child',
        world: base({ combine: combine('deny-overrides', 'm1', 'm2'), models: [staticModel('m1', PERMITS), staticModel('m2')], domains: { fs: { disable: ['m1'], combine: combine('deny-overrides', 'm2') } } }),
        steps: [{ models: ['m2'], domain: 'fs' }, check(false, 'fs'), check(true)],
      },
      {
        name: 'disposing the domain disposes its models; the parent keeps working',
        world: base({ domains: { fs: { models: [staticModel('m3', PERMITS)], combine: combine('deny-overrides', 'm1', 'm3') } } }),
        steps: [check(true, 'fs'), { disposeDomain: 'fs' }, { calls: { model: 'm3', domain: 'fs', method: 'dispose', count: 1 } }, { calls: { model: 'm1', method: 'dispose', count: 0 } }, check(false)],
      },
    ],
  },
  { name: 'fs', facets: ['fs'], lanes: ['L7'], note: "The fs domain with FsInheritModel and FsPathResolver; L7 proposes the cases. The DI part of B29 is F2's packages/di/test/child-chain.test.ts.", cases: [] },
]);
