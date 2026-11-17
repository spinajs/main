import { eventsHash, payloadHash, sealHash } from '@spinajs/audit';
import type { AuditPinnedHead, AuditSubject, AuditTamper, AuditUncoveredRow, AuditVerifyReport, StoredAuditEvent } from '@spinajs/audit';
import { InvalidOperation } from '@spinajs/exceptions';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { rowsOf, toStored } from '../rows.js';
import type { AuditRow } from '../rows.js';
import { sealConfig } from './seal.js';
import { SEAL_PAGE_SIZE, lastSeal, rowDigest, sealById, sealsAfter, storedHash } from './seals.js';
import type { AuditSeal } from './seals.js';

// Hash recomputations one seal may spend finding the rows that were committed into its range after it was sealed: one
// late row is always found, two or more only in small seals.
const LATE_SEARCH_BUDGET = 2000;
const SUBJECT_CHUNK = 500;
// Clocks of the writing process and the sealer may differ by this much.
const CLOCK_SKEW_MS = 5000;
/** An archive row carries `at` from another application's clock: the queue consumer accepts it up to 5 minutes ahead. */
export const ARCHIVE_CLOCK_SKEW_MS = 5 * 60 * 1000;
// AuditSealTask's period: a row is sealed by the run after the one that first saw it.
const SEAL_PERIOD_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface VerifyTableOptions {
  /** A seal's end and hash kept outside the database: the chain must meet it. */
  readonly pinned?: AuditPinnedHead;
  /** The trail's retention: a seal marked pruned younger than that, or at all without it, was not pruned by retention. */
  readonly retentionDays?: number;
  /** How far a row's `at` may run ahead of the sealer's clock; default 5 s. */
  readonly clockSkewMs?: number;
  readonly now?: Date;
}

interface Checked {
  readonly seq: number;
  readonly digest: string;
  readonly redacted: boolean;
  readonly subject: AuditSubject | undefined;
  readonly at: number;
}

interface Walk {
  seals: number;
  intact: number;
  redacted: number;
  prunedSeals: number;
  readonly uncovered: AuditUncoveredRow[];
  readonly earlyPrunes: { readonly fromSeq: number; readonly toSeq: number }[];
  readonly redactions: Checked[];
}

const tamper = (seal: AuditSeal, reason: AuditTamper['reason'], seq: number): AuditTamper => ({ seq, reason, fromSeq: seal.fromSeq, toSeq: seal.toSeq });

/** The row's digest, or the tamper of a payload that no longer matches its data_hash or is not JSON. */
function check(row: AuditRow, seal: AuditSeal): Checked | AuditTamper {
  let stored: StoredAuditEvent;
  try {
    stored = toStored(row);
  } catch {
    return tamper(seal, 'payload', Number(row.seq));
  }
  const kept = storedHash(row);
  if (!stored.redacted && kept !== undefined && kept !== payloadHash(stored.data)) return tamper(seal, 'payload', stored.seq);
  return { seq: stored.seq, digest: rowDigest(row, stored), redacted: stored.redacted, subject: stored.subject, at: stored.at.getTime() };
}

function* choices(n: number, k: number, from = 0): Generator<number[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = from; i <= n - k; i += 1) for (const rest of choices(n, k - 1, i + 1)) yield [i, ...rest];
}

/** The rows the seal did not see: those whose removal reproduces its hash; undefined when no such rows are found within the budget. */
function lateRows(rows: readonly Checked[], seal: AuditSeal): Checked[] | undefined {
  let budget = LATE_SEARCH_BUDGET;
  for (const left of choices(rows.length, rows.length - seal.count)) {
    if ((budget -= 1) < 0) return undefined;
    const digests = rows.filter((_, i) => !left.includes(i)).map((r) => r.digest);
    if (eventsHash(digests) === seal.eventsHash) return rows.filter((_, i) => left.includes(i));
  }
  return undefined;
}

const rangeOf = (driver: OrmDriver, table: string, after: number, seal: AuditSeal): SelectQueryBuilder<unknown> => driver.select().from(table).where('seq', '>', after).where('seq', '<=', seal.toSeq).orderBy('seq');

const uncoveredRows = (seqs: readonly number[], reason: AuditUncoveredRow['reason'], seal: AuditSeal): AuditUncoveredRow[] => seqs.map((seq) => ({ seq, reason, fromSeq: seal.fromSeq, toSeq: seal.toSeq }));

// Retention prunes seals older than retentionDays. A younger prune is lawful after retentionDays was raised or switched
// off, where this application has no retention for the trail, or through a direct AuditReader.prune: only doubted.
function prunedByRetention(seal: AuditSeal, retentionDays: number | undefined): boolean {
  if (retentionDays === undefined || seal.prunedAt === undefined) return false;
  return seal.prunedAt.getTime() - seal.sealedAt.getTime() >= retentionDays * DAY_MS - CLOCK_SKEW_MS;
}

async function checkPruned(driver: OrmDriver, table: string, seal: AuditSeal, after: number, walk: Walk, options: VerifyTableOptions): Promise<AuditTamper | undefined> {
  const now = (options.now ?? new Date()).getTime();
  if (seal.prunedAt === undefined || seal.prunedAt.getTime() > now + CLOCK_SKEW_MS) return tamper(seal, 'count', seal.fromSeq);
  if (!prunedByRetention(seal, options.retentionDays)) walk.earlyPrunes.push({ fromSeq: seal.fromSeq, toSeq: seal.toSeq });
  walk.prunedSeals += 1;
  const left = rowsOf(await rangeOf(driver, table, after, seal).columns(['seq']));
  walk.uncovered.push(
    ...uncoveredRows(
      left.map((r) => Number(r.seq)),
      'pruned',
      seal,
    ),
  );
  return undefined;
}

/** Recomputes one seal over its range `(after, to_seq]`; undefined when it still matches. */
async function checkSeal(driver: OrmDriver, table: string, seal: AuditSeal, after: number, walk: Walk, options: VerifyTableOptions): Promise<AuditTamper | undefined> {
  if (seal.fromSeq !== after + 1) return tamper(seal, 'chain', seal.fromSeq);
  // From the seal's own row: its time and events hash are checked even after retention removed its events.
  if (sealHash(seal.previousHash, seal.sealedAt, seal.eventsHash) !== seal.hash) return tamper(seal, 'seal', seal.fromSeq);
  if (seal.pruned) return checkPruned(driver, table, seal, after, walk, options);
  const rows: Checked[] = [];
  for (const row of rowsOf(await rangeOf(driver, table, after, seal))) {
    const checked = check(row, seal);
    if ('reason' in checked) return checked;
    rows.push(checked);
  }
  if (rows.length < seal.count) {
    // Retention may have pruned this seal since its page was read.
    const now = await sealById(driver, seal.id);
    return now?.pruned === true ? checkPruned(driver, table, now, after, walk, options) : tamper(seal, 'count', seal.fromSeq);
  }
  const late = rows.length > seal.count ? lateRows(rows, seal) : [];
  // A row's `at` is stamped before its insert: one stamped after the seal was made cannot have been committed late.
  if (late === undefined || late.some((r) => r.at > seal.sealedAt.getTime() + (options.clockSkewMs ?? CLOCK_SKEW_MS))) return tamper(seal, 'count', seal.fromSeq);
  const sealed = rows.filter((r) => !late.includes(r));
  if (late.length === 0 && eventsHash(sealed.map((r) => r.digest)) !== seal.eventsHash) return tamper(seal, 'seal', seal.fromSeq);
  walk.uncovered.push(
    ...uncoveredRows(
      late.map((r) => r.seq),
      'late',
      seal,
    ),
  );
  const redacted = sealed.filter((r) => r.redacted);
  walk.redactions.push(...redacted);
  walk.redacted += redacted.length;
  walk.intact += sealed.length - redacted.length;
  return undefined;
}

const keyOf = (subject: AuditSubject | undefined): string => JSON.stringify([subject?.type, subject?.id]);

interface Vouched {
  /** The end of the verified part of the chain. */
  readonly verifiedTo: number;
  readonly uncovered: ReadonlySet<number>;
  /** The end of the chain: rows after it are the unsealed tail. */
  readonly sealedTo: number;
  /** The oldest `at` a genuine erasure record can still have in the unsealed tail. */
  readonly freshFrom: number;
}

// An erasure record counts only where a seal vouches for it, or in the tail while a genuine one could still be unsealed.
const vouched = (erasure: StoredAuditEvent, v: Vouched): boolean => (erasure.seq <= v.verifiedTo && !v.uncovered.has(erasure.seq)) || (erasure.seq > v.sealedTo && erasure.at.getTime() >= v.freshFrom);

/** The redacted events that no vouched-for `erasure` record of their subject, at or after them, explains. */
async function unexplained(driver: OrmDriver, table: string, redactions: readonly Checked[], v: Vouched): Promise<number[]> {
  const subjects = [...new Map(redactions.flatMap((r) => (r.subject === undefined ? [] : [[keyOf(r.subject), r.subject] as const]))).values()];
  const erasedAt = new Map<string, number>();
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT per SUBJECT_CHUNK erased subjects
  for (let i = 0; i < subjects.length; i += SUBJECT_CHUNK) {
    const chunk = subjects.slice(i, i + SUBJECT_CHUNK);
    const select = driver.select().from(table).where('kind', 'custom').where('action', 'erasure');
    select.whereIn('subject_type', [...new Set(chunk.map((s) => s.type))]).whereIn('subject_id', [...new Set(chunk.map((s) => s.id))]);
    for (const erasure of rowsOf(await select).map(toStored)) {
      if (!vouched(erasure, v)) continue;
      const key = keyOf(erasure.subject);
      erasedAt.set(key, Math.max(erasedAt.get(key) ?? Number.NEGATIVE_INFINITY, erasure.at.getTime()));
    }
  }
  return redactions.filter((r) => !(r.at <= (erasedAt.get(keyOf(r.subject)) ?? Number.NEGATIVE_INFINITY))).map((r) => r.seq);
}

/**
 * The longest a genuine row waits unsealed: the sealer notes the head and seals it a settle time later, rounded up to its
 * period, and a row written just after a run is first noted by the next one. A backlog over audit.seal.maxSeals, a new
 * leader or failing runs can make it longer, which reads as suspect until the sealer catches up.
 */
function sealingWindow(skewMs: number): number {
  const settled = Math.max(SEAL_PERIOD_MS, Math.ceil(sealConfig().settleMs / SEAL_PERIOD_MS) * SEAL_PERIOD_MS);
  return 2 * settled + skewMs;
}

interface Chain {
  readonly good: AuditSeal | undefined;
  readonly tampered: AuditTamper | undefined;
}

// A seal must chain from the one verified before it, match a pinned head that ends where it ends, and be pruned only
// after every seal before it was.
function relink(seal: AuditSeal, good: AuditSeal | undefined, pinned: AuditPinnedHead | undefined): AuditTamper | undefined {
  if (seal.pruned && good !== undefined && !good.pruned) return tamper(seal, 'count', seal.fromSeq);
  const pinMismatch = seal.toSeq === pinned?.toSeq && seal.hash !== pinned.hash;
  return seal.previousHash !== (good?.hash ?? null) || pinMismatch ? tamper(seal, 'chain', seal.fromSeq) : undefined;
}

/** Walks the seal chain of one table from its first seal and stops at the first seal or event that does not match. */
async function walkChain(driver: OrmDriver, table: string, options: VerifyTableOptions, walk: Walk): Promise<Chain> {
  const { pinned } = options;
  let good: AuditSeal | undefined;
  let met = pinned === undefined;
  // spinajs-orm-ignore ORM102: deliberate paging, one SELECT of seals per page and one SELECT of events per seal
  for (;;) {
    const page = await sealsAfter(driver, table, good?.toSeq ?? 0);
    for (const seal of page) {
      walk.seals += 1;
      const tampered = relink(seal, good, pinned) ?? (await checkSeal(driver, table, seal, good?.toSeq ?? 0, walk, options));
      if (tampered) return { good, tampered };
      met ||= seal.toSeq === pinned?.toSeq;
      good = seal;
    }
    if (page.length < SEAL_PAGE_SIZE) break;
  }
  // The pinned seal is gone, or the chain was rewritten with other range ends.
  return { good, tampered: met || !pinned ? undefined : { seq: pinned.toSeq, reason: 'chain', fromSeq: pinned.toSeq, toSeq: pinned.toSeq } };
}

/**
 * Verifies the seal chain of one table. A pinned head protects the chain up to its `to_seq` only. It reads without a
 * transaction of its own and refuses a caller's: there it would count rows that can still roll back.
 */
export async function verifyTable(driver: OrmDriver, table: string, options: VerifyTableOptions = {}): Promise<Omit<AuditVerifyReport, 'trail'>> {
  if (driver.CurrentTransaction !== undefined) throw new InvalidOperation(`audit: verifying ${JSON.stringify(table)} on connection ${JSON.stringify(driver.Options.Name)} needs a transaction of its own; run it outside an open transaction`);
  const walk: Walk = { seals: 0, intact: 0, redacted: 0, prunedSeals: 0, uncovered: [], earlyPrunes: [], redactions: [] };
  const { good, tampered } = await walkChain(driver, table, options, walk);
  const sealedTo = (await lastSeal(driver, table))?.toSeq ?? 0;
  const { redactions, ...tally } = walk;
  const freshFrom = (options.now ?? new Date()).getTime() - sealingWindow(options.clockSkewMs ?? CLOCK_SKEW_MS);
  const v: Vouched = { verifiedTo: good?.toSeq ?? 0, uncovered: new Set(tally.uncovered.map((u) => u.seq)), sealedTo, freshFrom };
  return {
    connection: driver.Options.Name,
    table,
    ...tally,
    tampered,
    unsealed: await driver.select().from(table).where('seq', '>', sealedTo).selectCount(),
    staleUnsealed: await driver.select().from(table).where('seq', '>', sealedTo).where('at', '<', new Date(freshFrom)).selectCount(),
    head: good === undefined ? undefined : { toSeq: good.toSeq, hash: good.hash },
    unexplainedRedactions: await unexplained(driver, table, redactions, v),
  };
}
