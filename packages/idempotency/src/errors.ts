export class IdempotencyInFlight extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`another caller holds this idempotency key; retry in ${retryAfterMs} ms`);
    this.name = 'IdempotencyInFlight';
  }
}

/** Same key, different fingerprint. */
export class IdempotencyKeyReuse extends Error {
  constructor() {
    super('this idempotency key was used with a different request');
    this.name = 'IdempotencyKeyReuse';
  }
}

/** The abort reason of a handle's signal once its lease is lost: another caller may hold the key now. */
export class IdempotencyLeaseLost extends Error {
  constructor(public readonly key: string) {
    super(`the lease of idempotency key ${key} was lost`);
    this.name = 'IdempotencyLeaseLost';
  }
}

/**
 * Thrown by a call whose side effect may have happened although it answered nothing (the client went away): `run`
 * keeps the claim until its lease ends instead of releasing it, as it does for a dead process.
 */
export class IdempotencyOutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyOutcomeUnknown';
  }
}

/**
 * A claim made inside a transaction lost a deadlock or a serialization check (MySQL 1213, Postgres 40001 / 40P01).
 * The database rolled the surrounding transaction back: retry the whole transaction, not just the claim.
 */
export class IdempotencyClaimConflict extends Error {
  public readonly retryable = true;

  constructor(public readonly key: string, cause: unknown) {
    super(`idempotency key ${key}: the claim lost a lock or serialization conflict, so the database rolled the surrounding transaction back; retry that transaction`, { cause });
    this.name = 'IdempotencyClaimConflict';
  }
}

/**
 * The crash contract of the durable fault model: an error with `crash: true` stands for a dead process, which writes
 * and releases nothing. A claim it held is neither stored nor released; it frees itself when its lease ends.
 */
export function isCrash(error: unknown): error is { readonly crash: true } {
  return (error as { crash?: unknown } | null | undefined)?.crash === true;
}
