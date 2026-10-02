import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { SessionIssuer } from '../../src/contracts/session.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import type { IdentityRef } from '../../src/contracts/credentials.js';
import type { AuthnFacts } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

type Restored = { handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data: ReadonlyMap<string, unknown> };
type Listed = { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean };

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const alice: IdentityRef = { type: 'user', id: 'alice' };
const bob: IdentityRef = { type: 'user', id: 'bob' };
const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };

interface Row {
  id: string;
  identity: IdentityRef;
  impersonator?: IdentityRef;
  state: SessionHandle['state'];
  facts: AuthnFacts;
  data: Map<string, unknown>;
}

// Enough of an issuer to show the contract can be implemented as the design describes it.
class MemoryIssuer extends SessionIssuer {
  private rows: Row[] = [];
  private seq = 0;
  async issue(identity: IdentityRef, facts: AuthnFacts, opts?: { pending?: { steps: readonly string[] } }): Promise<SessionHandle> {
    const row: Row = { id: `s${++this.seq}`, identity, state: opts?.pending ? 'pending' : 'active', facts, data: new Map() };
    this.rows.push(row);
    return { id: row.id, state: row.state };
  }
  async restore(rawId: string): Promise<Restored | null> {
    const r = this.rows.find((x) => x.id === rawId);
    return r ? { handle: { id: r.id, state: r.state }, identity: r.identity, facts: r.facts, data: r.data } : null;
  }
  async rotate(h: SessionHandle): Promise<SessionHandle> {
    const r = this.rows.find((x) => x.id === h.id)!;
    r.id = `s${++this.seq}`;
    return { id: r.id, state: r.state };
  }
  async elevate(h: SessionHandle, more: Partial<AuthnFacts>): Promise<SessionHandle> {
    const r = this.rows.find((x) => x.id === h.id)!;
    r.state = 'active';
    r.facts = { ...r.facts, ...more };
    return this.rotate({ id: r.id, state: r.state });
  }
  async set(h: SessionHandle, key: string, value: unknown): Promise<void> {
    this.rows.find((x) => x.id === h.id)!.data.set(key, value);
  }
  async revoke(h: SessionHandle): Promise<void> {
    this.rows = this.rows.filter((x) => x.id !== h.id);
  }
  async revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number> {
    const hit = (r: Row) => r.id !== opts?.except?.id && (r.identity.id === subject.id || (!!opts?.includeImpersonations && r.impersonator?.id === subject.id));
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !hit(r));
    return before - this.rows.length;
  }
  async revokeHandle(subject: IdentityRef, handle: string): Promise<boolean> {
    const r = this.rows.find((x) => x.identity.id === subject.id && `h(${x.id})` === handle);
    if (!r) return false;
    this.rows = this.rows.filter((x) => x !== r);
    return true;
  }
  async list(subject: IdentityRef, opts?: { current?: SessionHandle }): Promise<readonly Listed[]> {
    return this.rows.filter((r) => r.identity.id === subject.id).map((r) => ({ handle: `h(${r.id})`, createdAt: new Date(0), lastSeenAt: new Date(0), ...(r.id === opts?.current?.id ? { current: true } : {}) }));
  }
  impersonate(h: SessionHandle, actor: IdentityRef, target: IdentityRef): void {
    const r = this.rows.find((x) => x.id === h.id)!;
    r.impersonator = actor;
    r.identity = target;
  }
}

interface MemberShape {
  name: string;
  modifiers: string[];
  optional: boolean;
  params: string[] | null;
  doc: string;
}

function classMembers(file: string): Record<string, { base: string | null; members: MemberShape[] }> {
  const sf = ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Record<string, { base: string | null; members: MemberShape[] }> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        optional: ts.isMethodDeclaration(m) && !!m.questionToken,
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        doc: ts
          .getJSDocCommentsAndTags(m)
          .map((d) => d.getText(sf))
          .join(' '),
      })),
    };
  });
  return out;
}

const shape = (members: MemberShape[]) => members.map(({ doc: _doc, ...rest }) => rest);
const docOf = (members: MemberShape[], name: string) => members.find((m) => m.name === name)?.doc ?? '';

describe('session issuer contract', () => {
  describe('runtime', () => {
    it('exports SessionIssuer from the contracts index as a plain abstract class', () => {
      expect(index.SessionIssuer).to.eq(SessionIssuer);
      expect(SessionIssuer).to.be.a('function');
      expect(Object.getPrototypeOf(SessionIssuer)).to.eq(Function.prototype);
    });

    it('a concrete issuer works', async () => {
      const s = new MemoryIssuer();
      const pending = await s.issue(alice, facts, { pending: { steps: ['totp'] } });
      expect(pending.state).to.eq('pending');
      const active = await s.elevate(pending, { assurance: 'aal2', mfa: ['totp'] });
      expect(active).to.deep.eq({ id: 's2', state: 'active' });
      expect(await s.restore(pending.id)).to.eq(null);
      await s.set(active, 'ActiveRole', 'admin');
      const restored = await s.restore(active.id);
      expect(restored!.facts.assurance).to.eq('aal2');
      expect(restored!.data.get('ActiveRole')).to.eq('admin');

      const other = await s.issue(alice, facts);
      const asBob = await s.issue(alice, facts);
      s.impersonate(asBob, alice, bob);
      expect(await s.list(alice)).to.have.length(2);
      expect((await s.list(alice, { current: active })).filter((r) => r.current).map((r) => r.handle)).to.deep.eq([`h(${active.id})`]);
      expect(await s.revokeHandle(bob, `h(${other.id})`)).to.eq(false);
      expect(await s.revokeHandle(alice, `h(${asBob.id})`)).to.eq(false);
      expect(await s.restore(other.id)).to.not.eq(null);
      const extra = await s.issue(alice, facts);
      expect(await s.revokeHandle(alice, `h(${extra.id})`)).to.eq(true);
      expect(await s.restore(extra.id)).to.eq(null);
      expect(await s.revokeAll(alice, { except: active })).to.eq(1);
      expect(await s.restore(other.id)).to.eq(null);
      expect(await s.restore(asBob.id)).to.not.eq(null);
      expect(await s.revokeAll(alice, { except: active, includeImpersonations: true })).to.eq(1);
      expect(await s.restore(asBob.id)).to.eq(null);
      await s.revoke(active);
      expect(await s.list(alice)).to.deep.eq([]);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('session.ts holds SessionIssuer with the design members', () => {
      const c = classMembers('session.ts');
      expect(Object.keys(c)).to.deep.eq(['SessionIssuer']);
      expect(c.SessionIssuer.base).to.eq(null);
      expect(shape(c.SessionIssuer.members)).to.deep.eq([
        { name: 'issue', modifiers: ['abstract'], optional: false, params: ['identity', 'facts', 'opts'] },
        { name: 'restore', modifiers: ['abstract'], optional: false, params: ['rawId'] },
        { name: 'rotate', modifiers: ['abstract'], optional: false, params: ['h'] },
        { name: 'elevate', modifiers: ['abstract'], optional: false, params: ['h', 'facts'] },
        { name: 'set', modifiers: ['abstract'], optional: false, params: ['h', 'key', 'value'] },
        { name: 'revoke', modifiers: ['abstract'], optional: false, params: ['h'] },
        { name: 'revokeAll', modifiers: ['abstract'], optional: false, params: ['subject', 'opts'] },
        { name: 'revokeHandle', modifiers: ['abstract'], optional: false, params: ['subject', 'handle'] },
        { name: 'list', modifiers: ['abstract'], optional: false, params: ['subject', 'opts'] },
      ]);
    });

    it('docs carry the rules a reader needs', () => {
      const m = classMembers('session.ts').SessionIssuer.members;
      expect(docOf(m, 'rotate')).to.contain('fixation');
      expect(docOf(m, 'elevate')).to.contain('pending');
      expect(docOf(m, 'elevate')).to.contain('aal2');
      expect(docOf(m, 'elevate')).to.contain('rotates');
      expect(docOf(m, 'set')).to.contain('ActiveRole');
      expect(docOf(m, 'set')).to.contain('impersonation');
      expect(docOf(m, 'revokeAll')).to.contain('impersonator');
      expect(docOf(m, 'revokeAll')).to.contain('SR-06');
      expect(docOf(m, 'list')).to.contain('current');
      expect(docOf(m, 'list')).to.contain('domain separation');
      expect(docOf(m, 'list')).to.contain('never the storage key or the raw id');
      expect(docOf(m, 'list')).to.contain('AuthnFacts.sessionHandle');
      expect(docOf(m, 'revokeHandle')).to.contain('DELETE /user/sessions/:handle');
      expect(docOf(m, 'revokeHandle')).to.contain('Owner-bound');
      expect(docOf(m, 'revokeHandle')).to.contain('IDOR');
      expect(docOf(m, 'revokeHandle')).to.contain('hashed');
      expect(docOf(m, 'set')).to.contain('Never changes the subject, impersonator or state');
      expect(docOf(m, 'issue')).to.contain('NEW session');
      expect(docOf(m, 'issue')).to.contain('facts.impersonator');
      expect(docOf(m, 'restore')).to.contain('A07');
      expect(docOf(m, 'restore')).to.contain('only a uuid v4 input falls back to a raw lookup');
      expect(docOf(m, 'restore')).to.contain('a stored hash never works as an id (SR-18)');
      expect(docOf(m, 'list')).to.contain('Includes sessions in which someone impersonates');
      expect(docOf(m, 'list')).to.contain("impersonator's ip and userAgent");
      expect(docOf(m, 'issue')).to.contain('A09');
    });
  });

  describe('types', () => {
    it('re-exports SessionIssuer from the contracts index', () => {
      same<index.SessionIssuer, SessionIssuer>(true);
    });

    it('members have the design types', () => {
      same<Parameters<SessionIssuer['issue']>, [IdentityRef, AuthnFacts, { pending?: { steps: readonly string[] } }?]>(true);
      same<ReturnType<SessionIssuer['issue']>, Promise<SessionHandle>>(true);
      same<Parameters<SessionIssuer['restore']>, [string]>(true);
      same<ReturnType<SessionIssuer['restore']>, Promise<Restored | null>>(true);
      same<Parameters<SessionIssuer['rotate']>, [SessionHandle]>(true);
      same<ReturnType<SessionIssuer['rotate']>, Promise<SessionHandle>>(true);
      same<Parameters<SessionIssuer['elevate']>, [SessionHandle, Partial<AuthnFacts>]>(true);
      same<ReturnType<SessionIssuer['elevate']>, Promise<SessionHandle>>(true);
      same<Parameters<SessionIssuer['set']>, [SessionHandle, string, unknown]>(true);
      same<ReturnType<SessionIssuer['set']>, Promise<void>>(true);
      same<Parameters<SessionIssuer['revoke']>, [SessionHandle]>(true);
      same<ReturnType<SessionIssuer['revoke']>, Promise<void>>(true);
      same<Parameters<SessionIssuer['revokeAll']>, [IdentityRef, { except?: SessionHandle; includeImpersonations?: boolean }?]>(true);
      same<ReturnType<SessionIssuer['revokeAll']>, Promise<number>>(true);
      same<Parameters<SessionIssuer['revokeHandle']>, [IdentityRef, string]>(true);
      same<ReturnType<SessionIssuer['revokeHandle']>, Promise<boolean>>(true);
      same<Parameters<SessionIssuer['list']>, [IdentityRef, { current?: SessionHandle }?]>(true);
      same<ReturnType<SessionIssuer['list']>, Promise<readonly Listed[]>>(true);
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new SessionIssuer();
      const s: SessionIssuer = new MemoryIssuer();
      // @ts-expect-error steps is a list
      const b = () => s.issue(alice, facts, { pending: { steps: 'totp' } });
      // @ts-expect-error except takes a handle, not a raw id
      const c = () => s.revokeAll(alice, { except: 's1' });
      // @ts-expect-error list needs a subject
      const d = () => s.list();
      // @ts-expect-error current takes a handle, not a flag
      const e = () => s.list(alice, { current: true });
      // @ts-expect-error revokeHandle needs the owner
      const f = () => s.revokeHandle('h');
      expect([a, b, c, d, e, f]).to.have.length(6);
    });

    it('a subclass missing revokeAll does not compile', () => {
      // @ts-expect-error revokeAll is missing
      class NoRevokeAll extends SessionIssuer {
        async issue(): Promise<SessionHandle> {
          return { id: 'x', state: 'active' };
        }
        async restore(): Promise<Restored | null> {
          return null;
        }
        async rotate(h: SessionHandle): Promise<SessionHandle> {
          return h;
        }
        async elevate(h: SessionHandle): Promise<SessionHandle> {
          return h;
        }
        async set(): Promise<void> {}
        async revoke(): Promise<void> {}
        async revokeHandle(): Promise<boolean> {
          return false;
        }
        async list(): Promise<readonly Listed[]> {
          return [];
        }
      }
      expect(NoRevokeAll).to.be.a('function');
    });

    it('revokeAll must report the count', () => {
      class VoidRevokeAll extends MemoryIssuer {
        // @ts-expect-error revokeAll resolves to the number of ended sessions
        async revokeAll(): Promise<void> {}
      }
      expect(VoidRevokeAll).to.be.a('function');
    });

    it('revokeHandle must report whether it ended a session', () => {
      class VoidRevokeHandle extends MemoryIssuer {
        // @ts-expect-error revokeHandle resolves to a boolean so a foreign handle is refused, not ignored
        async revokeHandle(): Promise<void> {}
      }
      expect(VoidRevokeHandle).to.be.a('function');
    });
  });
});
