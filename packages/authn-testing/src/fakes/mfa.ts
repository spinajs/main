import { randomBytes, randomInt } from 'node:crypto';
import { MfaPolicy, MfaStep } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';

interface State {
  enrolled: boolean;
  pending: string | null;
  codes: Set<string>;
  recovery: Set<string>;
}

const keyOf = (id: IdentityRef) => `${id.type}:${id.id}`;
const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export class FakeMfaStep extends MfaStep {
  readonly name: string;
  readonly verifyCalls: { id: IdentityRef; response: string }[] = [];
  declare verifyRecovery?: (id: IdentityRef, code: string) => Promise<boolean>;
  declare regenerateRecoveryCodes?: (id: IdentityRef) => Promise<readonly string[]>;
  private readonly states = new Map<string, State>();

  constructor(opts: { name?: string; recoveryCodes?: number | false } = {}) {
    super();
    this.name = opts.name ?? 'fake';
    if (this.name === 'recovery') {
      throw new Error("no MFA step may be named 'recovery'");
    }
    const count = opts.recoveryCodes ?? 10;
    if (count !== false) {
      this.verifyRecovery = async (id, code) => {
        const s = this.state(id);
        return s.enrolled && s.recovery.delete(code);
      };
      this.regenerateRecoveryCodes = async (id) => this.freshRecovery(id, count);
    }
    this.recoveryCount = count;
  }

  private readonly recoveryCount: number | false;

  private state(id: IdentityRef): State {
    let s = this.states.get(keyOf(id));
    if (!s) {
      s = { enrolled: false, pending: null, codes: new Set(), recovery: new Set() };
      this.states.set(keyOf(id), s);
    }
    return s;
  }

  private freshRecovery(id: IdentityRef, count: number): readonly string[] {
    const s = this.state(id);
    s.recovery = new Set(Array.from({ length: count }, () => 'rec-' + randomBytes(6).toString('hex')));
    return [...s.recovery];
  }

  enrol(id: IdentityRef): void {
    this.state(id).enrolled = true;
  }

  nextCode(id: IdentityRef): string {
    const s = this.state(id);
    let code = sixDigits();
    while (s.codes.has(code)) {
      code = sixDigits();
    }
    s.codes.add(code);
    return code;
  }

  async enrolled(id: IdentityRef): Promise<boolean> {
    return this.state(id).enrolled;
  }

  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    const code = sixDigits();
    this.state(id).pending = code;
    return { provisioning: `fake://enrol?code=${code}` };
  }

  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    const s = this.state(id);
    if (s.pending === null || s.pending !== response) {
      return {};
    }
    s.pending = null;
    s.enrolled = true;
    return typeof this.recoveryCount === 'number' ? { recoveryCodes: this.freshRecovery(id, this.recoveryCount) } : {};
  }

  async verify(id: IdentityRef, response: string): Promise<boolean> {
    this.verifyCalls.push({ id, response });
    const s = this.state(id);
    return s.enrolled && s.codes.delete(response);
  }

  async disable(id: IdentityRef): Promise<void> {
    this.states.delete(keyOf(id));
  }
}

export class EnrolledMfaPolicy extends MfaPolicy {
  private readonly methods: readonly string[];

  constructor(private readonly steps: readonly MfaStep[], opts: { methods?: readonly string[] } = {}) {
    super();
    this.methods = opts.methods ?? ['password'];
  }

  async required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    if (!this.methods.includes(facts.method)) {
      return [];
    }
    const names: string[] = [];
    for (const step of this.steps) {
      if (await step.enrolled(id)) {
        names.push(step.name);
      }
    }
    return names;
  }
}
