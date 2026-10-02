import { extension } from './dsl.js';
import { RULE_PERMISSIONS, RULE_PRINCIPALS, RULE_SETS, probeSteps, ruleWorld } from './rule-worlds.js';
import type { Case } from './types.js';

// B06 "also with RBAC rules on the type": the rule worlds that need no ConditionCompiler; those with
// conditions run in B44.config.
const cases = (): Case[] =>
  RULE_SETS.filter((s) => !s.conditions).map((s) => ({
    name: `${s.name}: check ⇔ filter`,
    world: ruleWorld(s.rules),
    steps: [{ agree: { as: RULE_PRINCIPALS, permissions: RULE_PERMISSIONS, type: 'file' } }, ...probeSteps(s)],
  }));

export const B06Rules = extension('B06', [
  {
    name: 'rules',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'list'],
    lanes: ['L1b'],
    note: 'In memory: the type-level RBAC residual carries the rule part (design §6.1.2, r3), which the lane evaluates through its NativeFilter in session.list. Files lie under p1/p2 under o1/o2. After agree, each case checks rows whose answer the rules change, so rules that do nothing fail.',
    cases: cases(),
  },
  {
    name: 'rulesSql',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'list', 'sql'],
    lanes: ['L4b', 'K1'],
    note: 'The rules worlds with the rows in SQLite and Postgres. These are the B44.config cases of the rule sets without conditions; a lane that runs both parts runs them twice. The rule kinds with conditions and the DB rules are B44.',
    cases: cases(),
  },
]);
