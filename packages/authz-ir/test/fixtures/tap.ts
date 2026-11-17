import { DecisionLogTap, FALSE, TRUE } from '@spinajs/authz';
import type { DecisionLog, DecisionReadSet, DecisionRecord, PolicyHashSource, Principal } from '@spinajs/authz';

import { policyHash } from '../../src/index.js';
import type { PolicyIR } from '../../src/index.js';

/** The record the real `DecisionLogTap` writes for a `doc:d1` decision of `permission`, logged now. */
export async function tapped(ir: PolicyIR, principal: Principal, env: Record<string, unknown>, allowed: boolean, o: { permission?: string; captureInputs?: boolean } = {}): Promise<DecisionRecord> {
  const out: DecisionRecord[] = [];
  const sink: DecisionLog = { write: (r) => Promise.resolve(void out.push(...r)) };
  const policy: PolicyHashSource = { policyHash: () => policyHash(ir) };
  const tap = new DecisionLogTap({ domain: 'default', sink, mode: 'all', allowSampleRate: 1, captureInputs: o.captureInputs ?? true, batch: { size: 1, flushMs: 1000 }, policy, log: { error: () => undefined } });
  const reads: DecisionReadSet = { env, attributes: [], relations: [], modelVersions: {} };
  const permission = o.permission ?? 'doc:edit';
  const resource = { type: 'doc', id: 'd1' };
  const decision = { allowed, permission, resource, principal: { type: principal.type, id: principal.id }, residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'default' };
  tap.onDecision({ principal, permission, resource, env }, decision, reads, { cached: false, durationMs: 3 });
  await tap.flush();
  return out[0];
}
