import type { Permission } from './permission.js';
import type { ResourceRef } from './principal.js';
import type { DecisionReadSet } from './tap.js';
import type { AuthzService } from './service.js';

/** What a replay needs of a principal to narrow like the engine did; never its attributes or authn. */
export interface PrincipalFactsRecord {
  type: string;
  id: string;
  ceiling?: { roles?: string[]; permissions?: string[]; resources?: Array<{ type: string; id?: string }>; expiresAt?: string };
  onBehalfOf?: PrincipalFactsRecord;
  delegation?: 'intersect' | 'inherit';
  /** principalKey() of each companion. */
  companions?: string[];
}

export interface CapturedInputs extends DecisionReadSet {
  /** The exact strings `inputsHash` hashed for the principal and the actor. */
  principalState: string | null;
  actorState: string | null;
}

/** One logged decision (G13); `inputsHash` lets a replay prove it saw the same inputs (G14). */
export interface DecisionRecord {
  /** UUIDv7, the `Decision.id` of the decision and the `decisionId` of its 403. */
  id: string;
  /** ISO instant of the check. */
  at: string;
  traceId?: string;
  spanId?: string;
  domain: string;
  /** principalKey() of the principal the decision names, and of its actor. */
  principal: string;
  actor?: string;
  permission: Permission;
  resource: ResourceRef;
  allowed: boolean;
  reason?: string;
  cached: boolean;
  /** `PolicyHashSource.policyHash(domain)`, `'unknown'` while none is registered. */
  policyHash: string;
  modelVersions: Record<string, string>;
  /** SHA-256 (hex) of the canonical inputs the decision read. */
  inputsHash: string;
  /** Authorization facts of the principal and actor, without attributes and authn; on every record. */
  facts?: { principal: PrincipalFactsRecord; actor?: PrincipalFactsRecord };
  /** Wall clock when the tap recorded (ISO); `at` may be the caller's `env.now`. Replay's T. */
  loggedAt?: string;
  /** The engine's `meta.durationMs`: how long before `loggedAt` the decision's reads may have happened. */
  durationMs?: number;
  /** Only with `authz.decisionLog.captureInputs`. */
  inputs?: CapturedInputs;
}

/** Where decision records go; writes are batched and a failed write never fails a check. */
export abstract class DecisionLog {
  public abstract write(records: DecisionRecord[]): Promise<void>;
}

/**
 * The hash of the policy a domain decides under. The policy IR (`@spinajs/authz-ir`) and the policy version store
 * register one; until then records carry `'unknown'`.
 */
export abstract class PolicyHashSource {
  public abstract policyHash(domain: string): string | undefined;
  /** Awaited by the host once a domain with a decision log has booted, before its service resolves. */
  public prepare?(domain: string, service: AuthzService): Promise<void>;
}

/** The trace a decision is made in; telemetry registers one so records carry trace ids and spans the decision id. */
export abstract class DecisionTraceContext {
  public abstract current(): { readonly traceId: string; readonly spanId: string } | undefined;
  /** Marks the active span with `spina.authz.decision_id`. */
  public abstract annotate(decisionId: string): void;
}
