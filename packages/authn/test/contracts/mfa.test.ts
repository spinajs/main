import * as chai from 'chai';
import 'mocha';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { MfaPolicy, MfaStep } from '../../src/contracts/mfa.js';
import { SecretStore } from '../../src/contracts/secrets.js';
import type { IdentityRef } from '../../src/contracts/credentials.js';
import type { AuthnFacts } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

const alice: IdentityRef = { type: 'user', id: 'alice' };
const bob: IdentityRef = { type: 'user', id: 'bob' };
const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };

class CodeStep extends MfaStep {
  readonly name = 'code';
  private pending = new Map<string, string>();
  private secrets = new Map<string, string>();
  async enrolled(id: IdentityRef): Promise<boolean> {
    return this.secrets.has(id.id);
  }
  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    this.pending.set(id.id, '123456');
    return { provisioning: 'otpauth://code/123456' };
  }
  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    if (this.pending.get(id.id) !== response) return {};
    this.secrets.set(id.id, response);
    this.pending.delete(id.id);
    return { recoveryCodes: ['r1', 'r2'] };
  }
  async verify(id: IdentityRef, response: string): Promise<boolean> {
    return this.secrets.get(id.id) === response;
  }
  async disable(id: IdentityRef): Promise<void> {
    this.secrets.delete(id.id);
  }
}

class EnrolledPolicy extends MfaPolicy {
  constructor(private steps: readonly MfaStep[]) {
    super();
  }
  async required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    if (facts.method !== 'password') return [];
    const out: string[] = [];
    for (const s of this.steps) if (await s.enrolled(id)) out.push(s.name);
    return out;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

class MemorySecrets extends SecretStore {
  readonly rows = new Map<string, { hash: Buffer; expiresAt: number }>();
  now = 0;
  async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    const raw = randomBytes(16).toString('base64url');
    this.rows.set(`${identity.id}|${purpose}`, { hash: sha256(raw), expiresAt: this.now + ttlSeconds * 1000 });
    return raw;
  }
  async redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean> {
    const key = `${identity.id}|${purpose}`;
    const row = this.rows.get(key);
    const ok = !!row && timingSafeEqual(row.hash, sha256(raw)) && row.expiresAt > this.now;
    if (ok) this.rows.delete(key);
    return ok;
  }
}

interface MemberShape {
  name: string;
  modifiers: string[];
  optional: boolean;
  params: string[] | null;
  doc: string;
}

interface ClassShape {
  base: string | null;
  doc: string;
  members: MemberShape[];
}

const docText = (n: ts.Node, sf: ts.SourceFile) =>
  ts
    .getJSDocCommentsAndTags(n)
    .map((d) => d.getText(sf))
    .join(' ');

function classMembers(file: string): Record<string, ClassShape> {
  const sf = ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Record<string, ClassShape> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      doc: docText(n, sf),
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        optional: (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && !!m.questionToken,
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        doc: docText(m, sf),
      })),
    };
  });
  return out;
}

const shape = (c: Record<string, ClassShape>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { base: v.base, members: v.members.map(({ doc: _doc, ...rest }) => rest) }]));
const docOf = (members: MemberShape[], name: string) => members.find((m) => m.name === name)?.doc ?? '';

describe('mfa and secret contracts', () => {
  describe('runtime', () => {
    it('exports MfaStep, MfaPolicy and SecretStore from the contracts index as plain abstract classes', () => {
      expect(index.MfaStep).to.eq(MfaStep);
      expect(index.MfaPolicy).to.eq(MfaPolicy);
      expect(index.SecretStore).to.eq(SecretStore);
      for (const c of [MfaStep, MfaPolicy, SecretStore]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('a concrete step and policy work', async () => {
      const step = new CodeStep();
      const policy = new EnrolledPolicy([step]);
      expect(await policy.required(alice, facts)).to.deep.eq([]);
      expect(await step.beginEnrolment(alice)).to.deep.eq({ provisioning: 'otpauth://code/123456' });
      expect(await step.confirmEnrolment(alice, '000000')).to.deep.eq({});
      expect(await step.confirmEnrolment(alice, '123456')).to.deep.eq({ recoveryCodes: ['r1', 'r2'] });
      expect(await policy.required(alice, facts)).to.deep.eq(['code']);
      expect(await policy.required(alice, { method: 'token', strategy: 'token' })).to.deep.eq([]);
      expect(await step.verify(alice, '123456')).to.eq(true);
      expect(await step.verify(alice, '654321')).to.eq(false);
      await step.disable(alice);
      expect(await step.enrolled(alice)).to.eq(false);
    });

    it('a concrete secret store works', async () => {
      const s = new MemorySecrets();
      const first = await s.issue(alice, 'reset', 60);
      const second = await s.issue(alice, 'reset', 60);
      expect(second).to.not.eq(first);
      expect(s.rows.get('alice|reset')!.hash.toString('hex')).to.not.contain(second);
      expect(await s.redeem(alice, 'reset', first)).to.eq(false);
      expect(await s.redeem(bob, 'reset', second)).to.eq(false);
      expect(await s.redeem(alice, 'invite', second)).to.eq(false);
      expect(await s.redeem(alice, 'reset', second)).to.eq(true);
      expect(await s.redeem(alice, 'reset', second)).to.eq(false);
      const late = await s.issue(alice, 'reset', 1);
      s.now = 1000;
      expect(await s.redeem(alice, 'reset', late)).to.eq(false);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('mfa.ts holds MfaStep and MfaPolicy with the design members', () => {
      expect(shape(classMembers('mfa.ts'))).to.deep.eq({
        MfaStep: {
          base: null,
          members: [
            { name: 'name', modifiers: ['abstract', 'readonly'], optional: false, params: null },
            { name: 'enrolled', modifiers: ['abstract'], optional: false, params: ['id'] },
            { name: 'beginEnrolment', modifiers: ['abstract'], optional: false, params: ['id'] },
            { name: 'confirmEnrolment', modifiers: ['abstract'], optional: false, params: ['id', 'response'] },
            { name: 'verify', modifiers: ['abstract'], optional: false, params: ['id', 'response'] },
            { name: 'disable', modifiers: ['abstract'], optional: false, params: ['id'] },
          ],
        },
        MfaPolicy: {
          base: null,
          members: [{ name: 'required', modifiers: ['abstract'], optional: false, params: ['id', 'facts'] }],
        },
      });
    });

    it('secrets.ts holds SecretStore with the design members', () => {
      expect(shape(classMembers('secrets.ts'))).to.deep.eq({
        SecretStore: {
          base: null,
          members: [
            { name: 'issue', modifiers: ['abstract'], optional: false, params: ['identity', 'purpose', 'ttlSeconds'] },
            { name: 'redeem', modifiers: ['abstract'], optional: false, params: ['identity', 'purpose', 'raw'] },
          ],
        },
      });
    });

    it('docs carry the rules a reader needs', () => {
      const mfa = classMembers('mfa.ts');
      const step = mfa.MfaStep.members;
      expect(docOf(step, 'beginEnrolment')).to.contain('owner only');
      expect(docOf(step, 'confirmEnrolment')).to.contain('SHA-256');
      expect(docOf(step, 'confirmEnrolment')).to.contain('single use');
      expect(docOf(step, 'verify')).to.contain('Counts into the throttle via AuthnService');
      expect(docOf(step, 'verify')).to.contain('A10');
      expect(docOf(step, 'disable')).to.contain('Owner: the caller checks fresh auth and a valid code or recovery code first');
      expect(docOf(step, 'disable')).to.contain('Admin reset (target guard, A25)');
      expect(docOf(step, 'disable')).to.contain('never receives a secret');
      expect(docOf(mfa.MfaPolicy.members, 'required')).to.contain('empty');

      const secrets = classMembers('secrets.ts').SecretStore;
      expect(secrets.doc).to.contain('SHA-256 only');
      expect(secrets.doc).to.contain('SR-09');
      expect(docOf(secrets.members, 'issue')).to.contain('raw secret once');
      expect(docOf(secrets.members, 'issue')).to.contain('replaces older ones of that purpose');
      expect(docOf(secrets.members, 'redeem')).to.contain('Constant time');
      expect(docOf(secrets.members, 'redeem')).to.contain('single use');
      expect(docOf(secrets.members, 'redeem')).to.contain('A11');
    });
  });

  describe('types', () => {
    it('re-exports the classes from the contracts index', () => {
      same<index.MfaStep, MfaStep>(true);
      same<index.MfaPolicy, MfaPolicy>(true);
      same<index.SecretStore, SecretStore>(true);
    });

    it('MfaStep members have the design types', () => {
      same<Pick<MfaStep, 'name'>, { readonly name: string }>(true);
      same<Parameters<MfaStep['enrolled']>, [IdentityRef]>(true);
      same<ReturnType<MfaStep['enrolled']>, Promise<boolean>>(true);
      same<Parameters<MfaStep['beginEnrolment']>, [IdentityRef]>(true);
      same<ReturnType<MfaStep['beginEnrolment']>, Promise<{ provisioning: string }>>(true);
      same<Parameters<MfaStep['confirmEnrolment']>, [IdentityRef, string]>(true);
      same<ReturnType<MfaStep['confirmEnrolment']>, Promise<{ recoveryCodes?: readonly string[] }>>(true);
      same<Parameters<MfaStep['verify']>, [IdentityRef, string]>(true);
      same<ReturnType<MfaStep['verify']>, Promise<boolean>>(true);
      same<Parameters<MfaStep['disable']>, [IdentityRef]>(true);
      same<ReturnType<MfaStep['disable']>, Promise<void>>(true);
    });

    it('MfaPolicy.required takes only method and strategy', () => {
      same<Parameters<MfaPolicy['required']>, [IdentityRef, Pick<AuthnFacts, 'method' | 'strategy'>]>(true);
      same<Parameters<MfaPolicy['required']>[1], { readonly method: string; readonly strategy: string }>(true);
      same<ReturnType<MfaPolicy['required']>, Promise<readonly string[]>>(true);
    });

    it('SecretStore returns the raw secret from issue and a boolean from redeem', () => {
      same<Parameters<SecretStore['issue']>, [IdentityRef, string, number]>(true);
      same<ReturnType<SecretStore['issue']>, Promise<string>>(true);
      same<Parameters<SecretStore['redeem']>, [IdentityRef, string, string]>(true);
      same<ReturnType<SecretStore['redeem']>, Promise<boolean>>(true);
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new MfaStep();
      // @ts-expect-error abstract
      const b = () => new MfaPolicy();
      // @ts-expect-error abstract
      const c = () => new SecretStore();
      const policy: MfaPolicy = new EnrolledPolicy([]);
      // @ts-expect-error strategy is required
      const d = () => policy.required(alice, { method: 'password' });
      const store: SecretStore = new MemorySecrets();
      // @ts-expect-error ttlSeconds is required
      const e = () => store.issue(alice, 'reset');
      // @ts-expect-error ttlSeconds is a number of seconds, not a date
      const f = () => store.issue(alice, 'reset', new Date());
      // @ts-expect-error redeem is bound to an identity
      const g = () => store.redeem('reset', 'raw');
      expect([a, b, c, d, e, f, g]).to.have.length(7);
    });

    it('a step missing disable does not compile', () => {
      // @ts-expect-error disable is missing
      class NoDisable extends MfaStep {
        readonly name = 'x';
        async enrolled(): Promise<boolean> {
          return false;
        }
        async beginEnrolment(): Promise<{ provisioning: string }> {
          return { provisioning: '' };
        }
        async confirmEnrolment(): Promise<{ recoveryCodes?: readonly string[] }> {
          return {};
        }
        async verify(): Promise<boolean> {
          return false;
        }
      }
      expect(NoDisable).to.be.a('function');
    });

    it('a step cannot hand out a secret from disable', () => {
      class LeakyDisable extends CodeStep {
        // @ts-expect-error disable resolves to nothing, so an admin reset returns no secret
        async disable(): Promise<string> {
          return 'secret';
        }
      }
      expect(LeakyDisable).to.be.a('function');
    });

    it('redeem must answer with a boolean', () => {
      class IdentityRedeem extends MemorySecrets {
        // @ts-expect-error redeem resolves to a boolean, not the identity
        async redeem(): Promise<IdentityRef> {
          return alice;
        }
      }
      expect(IdentityRedeem).to.be.a('function');
    });
  });
});
