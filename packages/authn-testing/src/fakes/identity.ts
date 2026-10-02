import { randomUUID } from 'node:crypto';
import { IdentityStore } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';

type StatusFlags = Partial<Omit<IdentityStatus, 'exists'>>;

export interface FakeIdentitySpec {
  readonly type?: IdentityRef['type'];
  readonly id?: string;
  readonly login: string;
  readonly email?: string;
  readonly name?: string;
  readonly status?: StatusFlags;
}

interface Entry {
  readonly ref: IdentityRef;
  readonly login: string;
  readonly email?: string;
  readonly name?: string;
  status: StatusFlags;
}

const keyOf = (id: IdentityRef) => `${id.type}:${id.id}`;

export class FakeIdentityStore extends IdentityStore {
  readonly calls: { findByLogin: string[]; status: IdentityRef[]; provision: ExternalSubject[] } = { findByLogin: [], status: [], provision: [] };
  private readonly entries = new Map<string, Entry>();

  constructor(opts: { jit?: boolean } = {}) {
    super();
    if (opts.jit) {
      this.provision = async (external: ExternalSubject) => {
        this.calls.provision.push(external);
        return this.add({ login: external.email ?? `${external.provider}:${external.subject}`, email: external.email });
      };
    }
  }

  declare provision?: (external: ExternalSubject) => Promise<IdentityRef>;

  add(spec: FakeIdentitySpec): IdentityRef {
    const ref: IdentityRef = { type: spec.type ?? 'user', id: spec.id ?? randomUUID() };
    this.entries.set(keyOf(ref), { ref, login: spec.login, email: spec.email, name: spec.name, status: { active: true, banned: false, deleted: false, ...spec.status } });
    return ref;
  }

  setStatus(id: IdentityRef, status: StatusFlags): void {
    const e = this.entries.get(keyOf(id));
    if (e) {
      e.status = { ...e.status, ...status };
    }
  }

  remove(id: IdentityRef): void {
    this.entries.delete(keyOf(id));
  }

  async findByLogin(login: string): Promise<IdentityRef | null> {
    this.calls.findByLogin.push(login);
    const needle = login.toLowerCase();
    for (const e of this.entries.values()) {
      if (e.login.toLowerCase() === needle || e.email?.toLowerCase() === needle) {
        return e.ref;
      }
    }
    return null;
  }

  async status(id: IdentityRef): Promise<IdentityStatus> {
    this.calls.status.push(id);
    const e = this.entries.get(keyOf(id));
    if (!e) {
      return { exists: false, active: false, banned: false, deleted: false };
    }
    return { exists: true, active: false, banned: false, deleted: false, ...e.status };
  }

  async display(id: IdentityRef): Promise<{ email?: string; name?: string }> {
    const e = this.entries.get(keyOf(id));
    const out: { email?: string; name?: string } = {};
    if (e?.email !== undefined) out.email = e.email;
    if (e?.name !== undefined) out.name = e.name;
    return out;
  }
}
