import { randomInt } from 'node:crypto';
import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { Class, DI, Injectable, SyncService } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import './register-schema.js';
import { InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { PASSWORD_HARD_CAP } from '@spinajs/authn/contracts';
import type { PasswordPolicy, PasswordPolicyContext, PasswordViolation } from '@spinajs/authn/contracts';

import { AUTHN_LOCAL_DEFAULTS } from './defaults.js';

/** Bounds every password must stay within, whatever the policy says (A04). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Above this many code points `check` answers `too_long` without running the rule or the blocklist on the input. */
export { PASSWORD_HARD_CAP };

/**
 * How many draws `generate()` makes before declaring the pool and the rule incompatible. A uniform draw can miss a class the rule
 * demands (about 6% of 16-character alphanumeric draws have no digit); ten draws bring a spurious failure to about 6e-13.
 */
const GENERATE_ATTEMPTS = 10;

/** Shorter identifiers would match inside too many unrelated passwords. */
const MIN_IDENTIFIER_LENGTH = 3;
const MAX_IDENTIFIER_EDITS = 2;

// ajv is CommonJS; depending on the build its default import is the class itself or an object holding it in `default`.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts?: object) => { compile(schema: object): ValidateFunction };

/** Optional hook (e.g. a k-anonymity breach check), named by `authn.local.policy.blocklist`. */
export abstract class PasswordBlocklist {
  public abstract isBlocked(password: string, ctx?: PasswordPolicyContext): Promise<boolean>;
}

export interface GeneratorConfig {
  readonly length: number;
  /** Concatenated into one pool; duplicates count once. */
  readonly characters: readonly string[];
}

export interface LocalPasswordPolicyOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A JSON schema the password string must match; null: none. */
  readonly rule?: object | null;
  readonly description?: string;
  readonly blocklist?: PasswordBlocklist | null;
  /** Refuse passwords too close to the login, email or name; default true. */
  readonly similarity?: boolean;
  readonly generator?: GeneratorConfig;
}

interface PolicySettings {
  readonly minLength: number;
  readonly maxLength: number;
  readonly rule: ValidateFunction | null;
  readonly pattern?: string;
  readonly description?: string;
}

export function codePointLength(password: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of password) {
    n++;
  }
  return n;
}

/** Lower-cased login, email and name, plus the local part of each that is an address. */
function identifiersOf(ctx: PasswordPolicyContext): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    const v = value.trim().toLowerCase();
    if (codePointLength(v) >= MIN_IDENTIFIER_LENGTH) {
      out.add(v);
    }
  };
  for (const value of [ctx.login, ctx.email, ctx.name]) {
    if (typeof value !== 'string') {
      continue;
    }
    add(value);
    const at = value.lastIndexOf('@');
    if (at > 0) {
      add(value.slice(0, at));
    }
  }
  return [...out];
}

/** Levenshtein distance over code points, given up as soon as it must exceed `max`. */
function withinEdits(a: string, b: string, max: number): boolean {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > max) {
    return false;
  }
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) {
      return false;
    }
    previous = current;
  }
  return previous[y.length] <= max;
}

/** Equal to, containing (ignoring case) or within two edits of the login, the email, its local part or the name. */
function isSimilarToIdentifier(password: string, ctx: PasswordPolicyContext): boolean {
  const p = password.toLowerCase();
  return identifiersOf(ctx).some((id) => p.includes(id) || withinEdits(p, id, MAX_IDENTIFIER_EDITS));
}

/**
 * The login bound (D5): fixed at 8–128 so that raising `authn.local.policy.minLength` later does not lock out passwords set
 * under the old value.
 */
export function isLoginLength(password: string): boolean {
  const n = codePointLength(password);
  return n >= PASSWORD_MIN_LENGTH && n <= PASSWORD_MAX_LENGTH;
}

/** `check`, `policy` and the generator behind `PasswordService` (A04, SR-14). Passwords are never trimmed or normalised. */
@Injectable()
export class LocalPasswordPolicy extends SyncService {
  @Config('authn.local.policy.minLength')
  protected MinLength: number;

  @Config('authn.local.policy.maxLength')
  protected MaxLength: number;

  @Config('authn.local.policy.rule')
  protected Rule: object | null;

  @Config('authn.local.policy.description')
  protected Description: string | undefined;

  @Config('authn.local.generator')
  protected Generator: GeneratorConfig;

  @Config('authn.local.policy.similarity')
  protected Similarity: boolean;

  // A name read here and resolved below rather than @AutoinjectService, which logs a warning on every boot for the default null.
  @Config('authn.local.policy.blocklist')
  protected BlocklistName: string | null;

  private _settings?: PolicySettings;
  private _blocklistType?: Class<PasswordBlocklist> | null;
  private _blocklist?: Promise<PasswordBlocklist>;

  /** With `options` the configuration is not read at all, so a test can build one without a container. */
  constructor(protected readonly Options?: LocalPasswordPolicyOptions) {
    super();
  }

  /** Validates the bounds, the rule and the blocklist name, so a bad config fails at boot when resolved by DI. */
  public resolve(): void {
    void this.settings;
    void this.blocklistType;
    super.resolve();
  }

  public async check(password: string, ctx?: PasswordPolicyContext): Promise<PasswordViolation[]> {
    if (codePointLength(password) > PASSWORD_HARD_CAP) {
      return ['too_long'];
    }

    const violations = this.checkSync(password);
    if (ctx && this.similarity() && isSimilarToIdentifier(password, ctx)) {
      violations.push('similar_to_identifier');
    }
    const blocklist = await this.blocklist();
    if (blocklist && (await blocklist.isBlocked(password, ctx))) {
      violations.push('blocklisted');
    }
    return violations;
  }

  public policy(): PasswordPolicy {
    const { minLength, maxLength, pattern, description } = this.settings;
    return {
      minLength,
      maxLength,
      ...(pattern !== undefined ? { pattern } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  /**
   * A random password from `authn.local.generator` that passes the length bounds and the rule (not the blocklist, which is async).
   *
   * @throws UnexpectedServerError when the generator config cannot produce such a password: a configuration fault no caller can
   *   fix, so it must never reach a client as a 400.
   */
  public generate(): string {
    const { minLength, maxLength } = this.settings;
    const { length, characters } = this.Options ? { ...AUTHN_LOCAL_DEFAULTS.generator, ...this.Options.generator } : this.Generator;
    const pool = [...new Set([...characters.join('')])];

    if (length < minLength || length > maxLength) {
      throw new UnexpectedServerError(`authn.local.generator.length ${length} is outside authn.local.policy bounds ${minLength}–${maxLength}`);
    }

    for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
      const candidate = Array.from({ length }, () => pool[randomInt(pool.length)]).join('');
      if (this.checkSync(candidate).length === 0) {
        return candidate;
      }
    }

    throw new UnexpectedServerError(
      `Could not generate a password satisfying authn.local.policy.rule in ${GENERATE_ATTEMPTS} attempts. The generator character pool and the rule disagree - check authn.local.generator.`,
    );
  }

  protected checkSync(password: string): PasswordViolation[] {
    const { minLength, maxLength, rule } = this.settings;
    const violations: PasswordViolation[] = [];
    const n = codePointLength(password);

    if (n < minLength) {
      violations.push('too_short');
    } else if (n > maxLength) {
      violations.push('too_long');
    }

    if (rule && !rule(password)) {
      violations.push('rule');
    }

    return violations;
  }

  protected similarity(): boolean {
    return this.Options ? (this.Options.similarity ?? AUTHN_LOCAL_DEFAULTS.policy.similarity) : this.Similarity !== false;
  }

  protected async blocklist(): Promise<PasswordBlocklist | null> {
    if (this.Options) {
      return this.Options.blocklist ?? null;
    }
    const type = this.blocklistType;
    return type
      ? (this._blocklist ??= this.createBlocklist(type).catch((err) => {
          this._blocklist = undefined;
          throw err;
        }))
      : null;
  }

  protected createBlocklist(type: Class<PasswordBlocklist>): Promise<PasswordBlocklist> {
    return Promise.resolve(DI.resolve(type));
  }

  protected get blocklistType(): Class<PasswordBlocklist> | null {
    if (this.Options) {
      return null;
    }
    if (this._blocklistType === undefined) {
      const name = this.BlocklistName;
      if (name === null || name === undefined || name === '') {
        this._blocklistType = null;
      } else {
        const type = (DI.getRegisteredTypes(PasswordBlocklist) ?? []).find((t) => t.name === name);
        if (!type) {
          throw new InvalidOption(`authn.local.policy.blocklist names ${String(name)}, which is not registered as a PasswordBlocklist`);
        }
        this._blocklistType = type as Class<PasswordBlocklist>;
      }
    }
    return this._blocklistType;
  }

  protected get settings(): PolicySettings {
    return (this._settings ??= this.buildSettings(
      this.Options ?? { minLength: this.MinLength, maxLength: this.MaxLength, rule: this.Rule, description: this.Description },
    ));
  }

  private buildSettings(options: LocalPasswordPolicyOptions): PolicySettings {
    const minLength = options.minLength ?? AUTHN_LOCAL_DEFAULTS.policy.minLength;
    const maxLength = options.maxLength ?? AUTHN_LOCAL_DEFAULTS.policy.maxLength;

    // A seam or a raw config can skip the schema's minimum; a shorter one, or a NaN or string that no length is below,
    // would accept weak passwords at set time.
    if (!(Number.isInteger(minLength) && minLength >= PASSWORD_MIN_LENGTH)) {
      throw new InvalidOption(`authn.local.policy.minLength must be at least ${PASSWORD_MIN_LENGTH}, got ${minLength}`);
    }

    const schema = options.rule ?? null;
    let rule: ValidateFunction | null = null;
    if (schema !== null) {
      try {
        rule = new Ajv().compile(schema);
      } catch (err) {
        throw new InvalidOption(`authn.local.policy.rule does not compile: ${(err as Error).message}`);
      }
    }

    const pattern = (schema as { pattern?: unknown } | null)?.pattern;
    const description = options.description;

    return {
      minLength,
      maxLength,
      rule,
      ...(typeof pattern === 'string' ? { pattern } : {}),
      ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
    };
  }
}
