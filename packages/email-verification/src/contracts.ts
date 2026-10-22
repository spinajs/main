import { AsyncService } from '@spinajs/di';

export type VerdictResult = 'allow' | 'refuse' | 'unknown';

export interface DomainVerdict {
  readonly result: VerdictResult;
  readonly reason?: string;
  /** Replaces the verifier name as the result source, e.g. `list:admin` or `http:kickbox-open`. */
  readonly source?: string;
}

export interface CachedVerdict extends DomainVerdict {
  readonly checkedAt: number;
}

export const UNKNOWN: DomainVerdict = Object.freeze({ result: 'unknown' });

export type ListKind = 'block' | 'allow' | 'block-mx';
export const LIST_KINDS: readonly ListKind[] = ['block', 'allow', 'block-mx'];
export const ADMIN_SOURCE = 'admin';

export interface ListEntry {
  readonly domain: string;
  readonly kind: ListKind;
  readonly source: string;
}

export type EmailCheckResult =
  | { readonly allowed: true; readonly domain: string | null; readonly source?: string }
  | { readonly allowed: false; readonly code: string; readonly domain: string | null; readonly source: string; readonly reason: string };

export abstract class DomainVerifier extends AsyncService {
  public abstract readonly name: string;
  public abstract readonly cacheable: boolean;
  /** Sees the normalised ASCII domain only. */
  public abstract verify(domain: string): Promise<DomainVerdict>;
  /** Seconds to cache `verdict`; 0 keeps it out of every cache. */
  public abstract ttlFor(verdict: DomainVerdict): number;
}

export abstract class EmailVerificationStore extends AsyncService {
  public abstract getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null>;
  /** Stores nothing when `ttlSeconds` is 0 or less. */
  public abstract setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void>;
  public abstract loadLists(): Promise<ListEntry[]>;
  /** Opaque token that changes on every list write. */
  public abstract listVersion(): Promise<string>;
  public abstract upsertEntries(entries: readonly ListEntry[]): Promise<void>;
  public abstract removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void>;
  /** Readers see the old set or the new set, never a mix; no domains removes the source. */
  public abstract replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void>;
  public abstract getMeta(key: string): Promise<string | null>;
  public abstract setMeta(key: string, value: string): Promise<void>;
}
