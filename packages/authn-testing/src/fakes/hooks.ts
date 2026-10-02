import { ExternalLoginHook, ImpersonationGuard, RoleSource } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef, Principal } from '@spinajs/authn/contracts';
import type { GuardPort, RolesPort } from '../harness/ports.js';

type DenyCode = 'forbidden' | 'protected_role' | 'escalation';
type Role = { role: string; requirePassword: boolean };

const keyOf = (id: IdentityRef) => `${id.type}:${id.id}`;

export class FakeImpersonationGuard extends ImpersonationGuard implements GuardPort {
  readonly calls: { actor: Principal; target: IdentityRef }[] = [];
  private denyAll: DenyCode | null = null;
  private readonly denyTarget = new Map<string, DenyCode>();

  async allowAll(): Promise<void> {
    this.denyAll = null;
    this.denyTarget.clear();
  }

  async deny(code: DenyCode, target?: IdentityRef): Promise<void> {
    if (target) {
      this.denyTarget.set(keyOf(target), code);
    } else {
      this.denyAll = code;
    }
  }

  async allowed(actor: Principal, target: IdentityRef): Promise<{ ok: true } | { ok: false; code: DenyCode }> {
    this.calls.push({ actor, target });
    const code = this.denyTarget.get(keyOf(target)) ?? this.denyAll;
    return code ? { ok: false, code } : { ok: true };
  }
}

export class FakeRoleSource extends RoleSource implements RolesPort {
  private readonly roles = new Map<string, readonly Role[]>();

  async grant(id: IdentityRef, roles: readonly Role[]): Promise<void> {
    this.roles.set(id.id, roles);
  }

  async rolesOf(principal: Principal): Promise<readonly Role[]> {
    return this.roles.get(principal.id) ?? [];
  }
}

export class RecordingExternalLoginHook extends ExternalLoginHook {
  readonly calls: { identity: IdentityRef; external: ExternalSubject }[] = [];
  private error: Error | null = null;

  failWith(error: Error | null): void {
    this.error = error;
  }

  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    this.calls.push({ identity, external });
    if (this.error) {
      throw this.error;
    }
  }
}
