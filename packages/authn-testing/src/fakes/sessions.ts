import { createHash, randomBytes } from 'node:crypto';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import type { SessionStoragePort } from '../harness/ports.js';

export interface MemorySessionOptions {
  readonly idleMinutes?: number;
  readonly absoluteMinutes?: number;
  readonly pendingTtlSeconds?: number;
}

interface Row {
  subject: IdentityRef;
  impersonator?: PrincipalRef;
  state: 'pending' | 'active';
  facts: AuthnFacts;
  data: Map<string, unknown>;
  creation: number;
  lastSeen: number;
  expiresAt: number;
}

const RESERVED = new Set(['Subject', 'Impersonator', 'State', 'authn:facts']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const handleOf = (rowKey: string) => sha256hex('authn-testing/handle\0' + rowKey);
const sameRef = (a: PrincipalRef, b: PrincipalRef) => a.type === b.type && a.id === b.id;

export class MemorySessionIssuer extends SessionIssuer {
  readonly storage: SessionStoragePort;
  private readonly rows = new Map<string, Row>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly pendingMs: number;

  constructor(opts: MemorySessionOptions = {}) {
    super();
    this.idleMs = (opts.idleMinutes ?? 30) * 60_000;
    this.absoluteMs = (opts.absoluteMinutes ?? 480) * 60_000;
    this.pendingMs = (opts.pendingTtlSeconds ?? 300) * 1000;
    this.storage = {
      storedKeys: async () => [...this.rows.keys()],
      seedLegacy: async (r) => {
        const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: r.creation };
        this.rows.set(r.rawId, {
          subject: { type: 'user', id: r.user },
          impersonator: r.impersonator ? { type: 'user', id: r.impersonator } : undefined,
          state: r.authorized ? 'active' : 'pending',
          facts,
          data: new Map(),
          creation: r.creation.getTime(),
          lastSeen: r.creation.getTime(),
          expiresAt: r.creation.getTime() + this.idleMs,
        });
      },
    };
  }

  private newId(): string {
    return randomBytes(16).toString('base64url');
  }

  private alive(row: Row, now: number): boolean {
    return now < row.expiresAt && now < row.creation + this.absoluteMs;
  }

  /** Live row of a handle by raw id; expired rows are swept. */
  private find(h: SessionHandle): { key: string; row: Row } | null {
    const key = sha256hex(h.id);
    const row = this.rows.get(key);
    if (!row) {
      return null;
    }
    if (!this.alive(row, Date.now())) {
      this.rows.delete(key);
      return null;
    }
    return { key, row };
  }

  private need(h: SessionHandle): { key: string; row: Row } {
    const found = this.find(h);
    if (!found) {
      throw new Error('unknown or expired session');
    }
    return found;
  }

  private place(row: Row): SessionHandle {
    const id = this.newId();
    const key = sha256hex(id);
    row.facts = { ...row.facts, sessionHandle: handleOf(key) };
    this.rows.set(key, row);
    return { id, state: row.state };
  }

  async issue(identity: IdentityRef, facts: AuthnFacts, opts?: { pending?: { steps: readonly string[] } }): Promise<SessionHandle> {
    const now = Date.now();
    const pending = opts?.pending !== undefined;
    return this.place({
      subject: identity,
      impersonator: facts.impersonator,
      state: pending ? 'pending' : 'active',
      facts,
      data: new Map(),
      creation: now,
      lastSeen: now,
      expiresAt: now + (pending ? this.pendingMs : this.idleMs),
    });
  }

  async restore(rawId: string): Promise<{ handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data: ReadonlyMap<string, unknown> } | null> {
    const key = sha256hex(rawId);
    let row = this.rows.get(key);
    if (!row && UUID_V4.test(rawId)) {
      const legacy = this.rows.get(rawId);
      if (legacy) {
        this.rows.delete(rawId);
        this.rows.set(key, legacy);
        legacy.facts = { ...legacy.facts, sessionHandle: handleOf(key) };
        row = legacy;
      }
    }
    if (!row) {
      return null;
    }
    const now = Date.now();
    if (!this.alive(row, now)) {
      this.rows.delete(key);
      return null;
    }
    if (row.state === 'active') {
      row.lastSeen = now;
      row.expiresAt = Math.min(now + this.idleMs, row.creation + this.absoluteMs);
    }
    return { handle: { id: rawId, state: row.state }, identity: row.subject, facts: row.facts, data: new Map(row.data) };
  }

  async rotate(h: SessionHandle): Promise<SessionHandle> {
    const { key, row } = this.need(h);
    this.rows.delete(key);
    return this.place(row);
  }

  async elevate(h: SessionHandle, facts: Partial<AuthnFacts>): Promise<SessionHandle> {
    const { key, row } = this.need(h);
    if (row.state === 'active') {
      throw new Error('an active session cannot be elevated');
    }
    const now = Date.now();
    row.state = 'active';
    row.facts = { ...row.facts, assurance: 'aal2', ...facts };
    row.expiresAt = Math.min(now + this.idleMs, row.creation + this.absoluteMs);
    this.rows.delete(key);
    return this.place(row);
  }

  async set(h: SessionHandle, key: string, value: unknown): Promise<void> {
    if (RESERVED.has(key)) {
      throw new Error(`reserved session key: ${key}`);
    }
    this.need(h).row.data.set(key, value);
  }

  async revoke(h: SessionHandle): Promise<void> {
    this.rows.delete(sha256hex(h.id));
  }

  async revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number> {
    const exceptKey = opts?.except ? sha256hex(opts.except.id) : null;
    const now = Date.now();
    let count = 0;
    for (const [key, row] of [...this.rows]) {
      if (!this.alive(row, now)) {
        this.rows.delete(key);
        continue;
      }
      const owned = sameRef(row.subject, subject) || (opts?.includeImpersonations === true && row.impersonator !== undefined && sameRef(row.impersonator, subject));
      if (owned && key !== exceptKey) {
        this.rows.delete(key);
        count++;
      }
    }
    return count;
  }

  async revokeHandle(subject: IdentityRef, handle: string): Promise<boolean> {
    for (const [key, row] of this.rows) {
      if (handleOf(key) === handle && sameRef(row.subject, subject) && this.alive(row, Date.now())) {
        this.rows.delete(key);
        return true;
      }
    }
    return false;
  }

  async list(subject: IdentityRef, opts?: { current?: SessionHandle }): Promise<readonly { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[]> {
    const currentKey = opts?.current ? sha256hex(opts.current.id) : null;
    const now = Date.now();
    const out: { handle: string; createdAt: Date; lastSeenAt: Date; current?: boolean }[] = [];
    for (const [key, row] of this.rows) {
      if (row.state === 'active' && sameRef(row.subject, subject) && this.alive(row, now)) {
        out.push({ handle: handleOf(key), createdAt: new Date(row.creation), lastSeenAt: new Date(row.lastSeen), ...(key === currentKey ? { current: true } : {}) });
      }
    }
    return out;
  }
}
