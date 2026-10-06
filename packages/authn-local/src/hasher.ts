import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AsyncService, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { ConcurrencyLimiter } from './limiter.js';
import { formatStored, parseStored, pepperInput, PepperEntry } from './pepper.js';

/** Stored instead of a hash to make the current password unusable; never verifies. */
export const EXPIRED_PASSWORD_MARKER = '!expired';

export interface Argon2Cost {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** `authn.local.pepper`. */
export interface PepperConfig {
  /** Null or empty: no pepper. */
  readonly secret: string | null;
  readonly version: number;
  /** Older peppers that stored hashes may still carry; such hashes verify and need a rehash. */
  readonly previous?: readonly PepperEntry[];
}

export interface Argon2PasswordHasherOptions {
  readonly maxConcurrent?: number;
  readonly pepper?: PepperConfig;
}

export abstract class PasswordHasher extends AsyncService {
  public abstract hash(password: string): Promise<string>;

  /**
   * False for a wrong password and for any stored value that cannot match (null, {@link EXPIRED_PASSWORD_MARKER}, malformed,
   * unknown pepper version); those cost the same work as a real verify (A02). Never throws on a bad stored value.
   */
  public abstract verify(stored: string | null | undefined, password: string): Promise<boolean>;

  /** True when `stored`, after a successful verify, should be replaced by a fresh `hash` (A03). */
  public abstract needsRehash(stored: string): boolean;
}

interface HasherSettings {
  readonly maxConcurrent: number;
  readonly current: PepperEntry | null;
  readonly peppers: ReadonlyMap<number, PepperEntry>;
}

const DEFAULT_MAX_CONCURRENT = 8; // The Options seam's own fallback; the configured path takes the schema default.

/**
 * argon2id at the argon2 library defaults (H30, SR-13): no option and no config key sets a cost, so the stored hash starts with
 * `$argon2id$v=19$m=65536,t=3,p=4$` (argon2 0.44). Peak memory is `maxConcurrent` × 64 MiB; small hosts lower `maxConcurrent`.
 */
@Injectable(PasswordHasher)
export class Argon2PasswordHasher extends PasswordHasher {
  @Config('authn.local.hasher.maxConcurrent')
  protected MaxConcurrent: number;

  @Config('authn.local.pepper')
  protected Pepper: PepperConfig;

  private _settings?: HasherSettings;
  private _limiter?: ConcurrencyLimiter;
  private _dummy?: Promise<string>;

  /** With `options` the configuration is not read at all, so a test can build one without a container. */
  constructor(protected readonly Options?: Argon2PasswordHasherOptions) {
    super();
  }

  public async resolve(): Promise<void> {
    await this.dummy();
    await super.resolve();
  }

  /** Every argon2 operation of this hasher, dummy verifies included, runs through it (SR-03). */
  public get limiter(): ConcurrencyLimiter {
    return (this._limiter ??= new ConcurrencyLimiter(this.settings.maxConcurrent));
  }

  public async hash(password: string): Promise<string> {
    return this.hashWith(password, {});
  }

  /**
   * A hash in the stored format under explicit argon2 parameters or another pepper, for tests and migrations; `hash` is the
   * production path. `argon2` omitted: library defaults. `pepper` omitted: the current one; null: none.
   */
  public async hashWith(password: string, opts: { readonly argon2?: Argon2Cost; readonly pepper?: PepperEntry | null }): Promise<string> {
    const pepper = opts.pepper === undefined ? this.settings.current : opts.pepper;
    const input = pepper ? pepperInput(password, pepper.secret) : password;
    const encoded = await this.limiter.run(() => (opts.argon2 ? argon2.hash(input, { ...opts.argon2, type: argon2.argon2id }) : argon2.hash(input)));
    return formatStored(encoded, pepper ? pepper.version : null);
  }

  public async verify(stored: string | null | undefined, password: string): Promise<boolean> {
    const parsed = typeof stored === 'string' ? parseStored(stored) : null;
    const pepper = parsed ? this.pepperFor(parsed.version) : undefined;

    if (!parsed || pepper === undefined) {
      const dummy = await this.dummy();
      await this.limiter.run(() => this.dummyVerify(dummy, password));
      return false;
    }

    const dummy = await this.dummy();
    return this.limiter.run(async () => {
      try {
        return await argon2.verify(parsed.argon2, pepper ? pepperInput(password, pepper.secret) : password);
      } catch {
        // The PHC string passed the shape check but argon2 still refused it; spend the work a real verify would.
        await this.dummyVerify(dummy, password);
        return false;
      }
    });
  }

  public needsRehash(stored: string): boolean {
    const parsed = parseStored(stored);
    if (!parsed || parsed.version !== (this.settings.current?.version ?? null) || !parsed.argon2.startsWith('$argon2id$')) {
      return true;
    }

    try {
      return argon2.needsRehash(parsed.argon2);
    } catch {
      return true;
    }
  }

  protected get settings(): HasherSettings {
    return (this._settings ??= this.buildSettings(
      this.Options ? { ...this.Options, maxConcurrent: this.Options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT } : { maxConcurrent: this.MaxConcurrent, pepper: this.Pepper },
    ));
  }

  /** undefined: no pepper of that version is known; null: the hash has no pepper. */
  protected pepperFor(version: number | null): PepperEntry | null | undefined {
    return version === null ? null : this.settings.peppers.get(version);
  }

  /** Same parameters and pepper as a real hash, so a verify against it costs the same; made once, at boot when resolved by DI. */
  protected dummy(): Promise<string> {
    return (this._dummy ??= this.hash(randomBytes(32).toString('base64url')).catch((err) => {
      this._dummy = undefined;
      throw err;
    }));
  }

  private async dummyVerify(dummy: string, password: string): Promise<void> {
    const parsed = parseStored(dummy)!;
    const pepper = this.pepperFor(parsed.version);
    await argon2.verify(parsed.argon2, pepper ? pepperInput(password, pepper.secret) : password);
  }

  private buildSettings(options: Argon2PasswordHasherOptions & { readonly maxConcurrent: number }): HasherSettings {
    const peppers = new Map<number, PepperEntry>();
    let current: PepperEntry | null = null;

    if (options.pepper?.secret) {
      current = { secret: options.pepper.secret, version: options.pepper.version };
      peppers.set(current.version, current);
    }

    for (const entry of options.pepper?.previous ?? []) {
      peppers.set(entry.version, { secret: entry.secret, version: entry.version });
    }

    return { maxConcurrent: options.maxConcurrent, current, peppers };
  }
}
