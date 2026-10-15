import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourSelector } from '@spinajs/authz-testing';

import { ConfigRuleStore } from '../src/index.js';
import { rbacHarness } from './model/harness.js';

/*
 * L1b acceptance: every kit part tagged L1b, strict, on the RbacModel with its config rules and the
 * share links of `world.rbac.links` (lane handle rbacLinks).
 */

/** Every part of the kit tagged L1b but B06.rules, whose filters over rule-narrowed rows a type-level vote refuses (RuleRowsError). */
const L1B_PARTS: BehaviourSelector[] = ['B02.rules', 'B05.ladders', 'B05.rules', 'B12.implies', 'B31.ladders', 'B31.rules', 'B32.ladders', 'B32.rules', 'B33.sets', 'B34.ladders', 'B35.rules', 'B35.conditions', 'B36.rbac', 'B38.rbac', 'B42.rbac', 'B46.rules', 'B46.links'];

const harness = () => rbacHarness({ facets: ['ladders', 'rules', 'conditions', 'links'], rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []) });

runBehaviour(L1B_PARTS, harness, { strict: true, timeoutMs: 30_000 });
