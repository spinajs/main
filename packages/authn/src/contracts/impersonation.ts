import type { IdentityRef } from './credentials.js';
import type { Principal } from './principal.js';

/**
 * Implemented in users by AuthzImpersonationGuard with authz (D26): forbidden without user:impersonate (B26),
 * protected_role when the target holds a protected role, escalation when the actor does not cover the target's rights.
 */
export abstract class ImpersonationGuard {
  abstract allowed(actor: Principal, target: IdentityRef): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'protected_role' | 'escalation' }>;
}
