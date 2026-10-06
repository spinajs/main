import { randomInt } from 'node:crypto';
import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import { Class, DI, Injectable, SyncService } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import type { PasswordPolicy, PasswordViolation } from '@spinajs/authn/contracts';

/** Bounds every password must stay within, whatever the policy says (A04). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Above this many code points `check` answers `too_long` without running the rule or the blocklist on the input. */
export const PASSWORD_HARD_CAP = 1024;

/**
 * How many draws `generate()` makes before declaring the pool and the rule incompatible. A uniform draw can miss a class the rule
 * demands (about 6% of 16-character alphanumeric draws have no digit); ten draws bring a spurious failure to about 6e-13.
 */
const GENERATE_ATTEMPTS = 10;

const DEFAULT_GENERATOR: GeneratorConfig = { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] };

// ajv is CommonJS; depending on the build its default import is the class itself or an object holding it in `default`.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts?: object) => { compile(schema: object): ValidateFunction };

/** Optional hook (e.g. a k-anonymity breach check), named by `authn.local.policy.blocklist`. */
export abstract class PasswordBlocklist {
  public abstract isBlocked(password: string): Promise<boolean>;
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

  public async check(password: string): Promise<PasswordViolation[]> {
    if (codePointLength(password) > PASSWORD_HARD_CAP) {
      return ['too_long'];
    }

    const violations = this.checkSync(password);
    const blocklist = await this.blocklist();
    if (blocklist && (await blocklist.isBlocked(password))) {
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
    const { length, characters } = this.Options ? { ...DEFAULT_GENERATOR, ...this.Options.generator } : this.Generator;
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
        const type = DI.getRegisteredTypes(PasswordBlocklist).find((t) => t.name === name);
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
    const minLength = options.minLength ?? PASSWORD_MIN_LENGTH;
    const maxLength = options.maxLength ?? PASSWORD_MAX_LENGTH;

    // A seam or a raw config can skip the schema's minimum; a shorter minimum would accept weak passwords at set time.
    if (minLength < PASSWORD_MIN_LENGTH) {
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
