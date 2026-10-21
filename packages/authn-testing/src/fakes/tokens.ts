import { createHash, randomBytes } from 'node:crypto';
import { TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, TokenCreateOptions, TokenCreateResult, TokenRecord, TokenRotateResult, TokenUpdate, TokenUpdateResult, TokenValidation } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_GRACE_SECONDS = 604_800;

interface Row {
  record: TokenRecord;
  hash: string;
  previous?: { readonly hash: string; readonly until: number };
  revoked: boolean;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sameOwner = (a: IdentityRef, b: IdentityRef): boolean => a.type === b.type && a.id === b.id;
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/** A TokenService over memory, for suites that need one without a database; the conformance runner holds it to the contract. */
export class MemoryTokenService extends TokenService {
  private readonly rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly caps: { readonly maxTtlDays: number; readonly agentMaxTtlMinutes: number } = { maxTtlDays: 90, agentMaxTtlMinutes: 1440 }) {
    super();
  }

  async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    const now = ctx.now.getTime();
    const agent = opts.kind === 'agent';
    if (agent !== (opts.scope?.agent === true) || (agent && (opts.roles !== undefined || opts.profile !== undefined))) {
      return { ok: false, code: 'invalid_scope' };
    }
    const cap = now + (agent ? this.caps.agentMaxTtlMinutes * MINUTE_MS : this.caps.maxTtlDays * DAY_MS);
    if (!isDate(opts.expiresAt) || opts.expiresAt.getTime() <= now || opts.expiresAt.getTime() > cap) {
      return { ok: false, code: 'invalid_expiry' };
    }

    const plaintext = `spt_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      id: `mem-token-${++this.sequence}`,
      owner: { type: owner.type, id: owner.id },
      name: opts.name,
      kind: opts.kind,
      ...(opts.roles !== undefined && opts.roles.length > 0 ? { roles: [...opts.roles] } : {}),
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      createdAt: ctx.now,
      expiresAt: opts.expiresAt,
    };
    this.rows.push({ record, hash: sha256(plaintext), revoked: false });
    return { ok: true, plaintext, record };
  }

  async list(owner: IdentityRef): Promise<readonly TokenRecord[]> {
    return this.rows.filter((r) => !r.revoked && sameOwner(r.record.owner, owner)).map((r) => r.record);
  }

  async revoke(owner: IdentityRef, id: string, _ctx: AuthnContext): Promise<boolean> {
    const row = this.liveRow(owner, id);
    if (row) {
      row.revoked = true;
    }
    return row !== undefined;
  }

  async rotate(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly graceSeconds?: number }): Promise<TokenRotateResult> {
    const grace = opts?.graceSeconds === undefined ? 0 : opts.graceSeconds;
    if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_SECONDS) {
      throw new InvalidArgument('graceSeconds must be a whole number of seconds from 0 to 604800');
    }
    const row = this.liveRow(owner, id);
    if (!row || row.record.expiresAt.getTime() <= ctx.now.getTime()) {
      return { ok: false, reason: 'not_found' };
    }

    const plaintext = `spt_${randomBytes(32).toString('base64url')}`;
    row.previous = grace > 0 ? { hash: row.hash, until: ctx.now.getTime() + grace * 1000 } : undefined;
    row.hash = sha256(plaintext);
    return { ok: true, plaintext, token: row.record };
  }

  async update(owner: IdentityRef, id: string, change: TokenUpdate, ctx: AuthnContext): Promise<TokenUpdateResult> {
    const row = this.liveRow(owner, id);
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    const { record } = row;
    if (change.roles !== undefined) {
      const held = record.roles ?? [];
      if (record.kind === 'agent' || change.roles.length === 0 || !change.roles.every((r) => held.includes(r))) {
        return { ok: false, reason: 'invalid_scope' };
      }
    }
    if (change.expiresAt !== undefined && !(isDate(change.expiresAt) && change.expiresAt.getTime() > ctx.now.getTime() && change.expiresAt.getTime() <= record.expiresAt.getTime())) {
      return { ok: false, reason: 'invalid_expiry' };
    }

    row.record = {
      ...record,
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.roles !== undefined ? { roles: [...new Set(change.roles)] } : {}),
      ...(change.expiresAt !== undefined ? { expiresAt: change.expiresAt } : {}),
    };
    return { ok: true, token: row.record };
  }

  async revokeAllFor(owner: IdentityRef, _ctx: AuthnContext): Promise<number> {
    const hit = this.rows.filter((r) => !r.revoked && sameOwner(r.record.owner, owner));
    hit.forEach((r) => (r.revoked = true));
    return hit.length;
  }

  async revokeByPlaintext(_raw: string, _ctx: AuthnContext): Promise<boolean> {
    throw new Error('not implemented: MemoryTokenService.revokeByPlaintext');
  }

  async validate(raw: string, ctx: AuthnContext): Promise<TokenValidation> {
    const hash = sha256(raw);
    const now = ctx.now.getTime();
    const row = this.rows.find((r) => r.hash === hash || (r.previous?.hash === hash && now < r.previous.until));
    if (!row) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (row.revoked) {
      return { ok: false, reason: 'revoked' };
    }
    const { record } = row;
    if (record.expiresAt.getTime() <= now) {
      return { ok: false, reason: 'expired' };
    }

    const limits = { ...(record.scope?.permissions !== undefined ? { permissions: record.scope.permissions } : {}), ...(record.scope?.resources !== undefined ? { resources: record.scope.resources } : {}) };
    if (record.kind === 'agent') {
      return { ok: true, identity: { type: 'agent', id: record.id }, method: 'token', ceiling: { ...limits, reason: 'out_of_scope' }, delegation: { onBehalfOf: record.owner, mode: 'inherit' }, token: record };
    }
    const ceiling = { ...(record.roles !== undefined ? { roles: record.roles } : {}), ...limits };
    return { ok: true, identity: record.owner, method: 'token', ...(Object.keys(ceiling).length > 0 ? { ceiling } : {}), ...(record.profile !== undefined ? { profile: record.profile } : {}), token: record };
  }

  private liveRow(owner: IdentityRef, id: string): Row | undefined {
    return this.rows.find((r) => !r.revoked && r.record.id === id && sameOwner(r.record.owner, owner));
  }
}
