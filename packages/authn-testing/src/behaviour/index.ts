import { A01 } from './A01-strategy-dispatch.spec.js';
import { A02 } from './A02-one-failure-answer.spec.js';
import { A03 } from './A03-password-hashing.spec.js';
import { A04 } from './A04-password-policy.spec.js';
import { A05 } from './A05-count-before-verify.spec.js';
import { A06 } from './A06-backoff.spec.js';
import { A07 } from './A07-session-ids.spec.js';
import { A08 } from './A08-session-end.spec.js';
import { A09 } from './A09-pending-session.spec.js';
import { A10 } from './A10-mfa.spec.js';
import { A11 } from './A11-single-use-secrets.spec.js';
import { A12 } from './A12-metadata-guard.spec.js';
import { A13 } from './A13-fresh-auth.spec.js';
import { A14 } from './A14-api-tokens.spec.js';
import { A15 } from './A15-agent-tokens.spec.js';
import { A16 } from './A16-jwt-bearer.spec.js';
import { A17 } from './A17-keys-jws.spec.js';
import { A18 } from './A18-http-signatures.spec.js';
import { A19 } from './A19-linking.spec.js';
import { A20 } from './A20-impersonation.spec.js';
import { A21 } from './A21-audit.spec.js';
import { A22 } from './A22-csrf.spec.js';
import { A23 } from './A23-principal-facts.spec.js';
import { A24 } from './A24-boot-secrets.spec.js';
import { A25 } from './A25-credential-admin.spec.js';
import { A26 } from './A26-role-switch.spec.js';
import { A27 } from './A27-oidc.spec.js';
import { A30 } from './A30-password-change.spec.js';
import { A31 } from './A31-cors.spec.js';
import { A32 } from './A32-upgrade-secrets.spec.js';
import { planCasesIn, runBehaviourIn } from './runner.js';
import type { PlannedCase } from './runner.js';
import type { AuthnRule, HarnessFactory, RuleId, RunOptions } from './types.js';

export * from './types.js';
export * from './steps.js';
export { DEFAULT_CASE_TIMEOUT_MS, PendingLog, executeCase, markPending, settleCase } from './runner.js';
export type { CaseResult, CaseStatus, PlannedCase } from './runner.js';

const ALL: readonly AuthnRule[] = [A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A30, A31, A32];

export const AUTHN_RULES: ReadonlyMap<RuleId, AuthnRule> = new Map(ALL.map((r) => [r.id, r]));

/** Rules whose cases are not transcribed yet; each batch removes its own ids from this one line. */
export const PENDING_TRANSCRIPTION: ReadonlySet<RuleId> = new Set<RuleId>(['A12', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A30', 'A31', 'A32']);

/** Validates ids, claim and facets (throws synchronously) and returns the cases to run. */
export function planCases(ids: readonly RuleId[], opts: RunOptions = {}): PlannedCase[] {
  return planCasesIn(AUTHN_RULES, ids, opts);
}

/**
 * Registers the behaviour cases of `ids` on mocha (describe per rule, it per case). Each case gets a fresh harness
 * from `factory`, a FakeClock (Date only) and its config; missing ports make it pending, or fail it when claimed.
 *
 * Time rules for the code under test: take "now" from ctx.now where a ctx exists; elsewhere read Date (or luxon)
 * at call time, never SQL now() for expiry or throttle decisions, never a Date captured at module load; bound
 * retry loops by count, not by elapsed time.
 */
export function runAuthnBehaviour(ids: readonly RuleId[], factory: HarnessFactory, opts: RunOptions = {}): void {
  runBehaviourIn(AUTHN_RULES, ids, factory, opts);
}
