import { payloadHash, sealHash } from '@spinajs/audit';
import type { AuditPinnedHead, AuditSubject, AuditTamper, AuditUncoveredRow, AuditVerifyReport, StoredAuditEvent } from '@spinajs/audit';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { rowsOf, toStored } from '../rows.js';
import type { AuditRow } from '../rows.js';
import { SEAL_PAGE_SIZE, lastSeal, rowDigest, sealsAfter, storedHash } from './seals.js';
import type { AuditSeal } from './seals.js';

// Hash recomputations one seal may spend finding the rows that were committed into its range after it was sealed.
const LATE_SEARCH_BUDGET = 2000;
const SUBJECT_CHUNK = 500;

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

/** The seqs the seal did not see: the rows whose removal reproduces its hash; undefined when no such rows are found within the budget. */
function lateRows(rows: readonly Checked[], seal: AuditSeal): Set<number> | undefined {
  let budget = LATE_SEARCH_BUDGET;
  for (const left of choices(rows.length, rows.length - seal.count)) {
    if ((budget -= 1) < 0) return undefined;
    const late = new Set(rows.filter((_, i) => left.includes(i)).map((r) => r.seq));
    const digests = rows.filter((r) => !late.has(r.seq)).map((r) => r.digest);
    if (sealHash(seal.previousHash, seal.sealedAt, digests) === seal.hash) return late;
  }
  return undefined;
}

const rangeOf = (driver: OrmDriver, table: string, after: number, seal: AuditSeal): SelectQueryBuilder<unknown> => driver.select().from(table).where('seq', '>', after).where('seq', '<=', seal.toSeq).orderBy('seq');

const uncoveredRows = (seqs: Iterable<number>, reason: AuditUncoveredRow['reason'], seal: AuditSeal): AuditUncoveredRow[] => [...seqs].map((seq) => ({ seq, reason, fromSeq: seal.fromSeq, toSeq: seal.toSeq }));

async function checkPruned(driver: OrmDriver, table: string, seal: AuditSeal, after: number, walk: Walk): Promise<undefined> {
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
async function checkSeal(driver: OrmDriver, table: string, seal: AuditSeal, after: number, walk: Walk): Promise<AuditTamper | undefined> {
  if (seal.fromSeq !== after + 1) return tamper(seal, 'chain', seal.fromSeq);
  if (seal.pruned) return checkPruned(driver, table, seal, after, walk);
  const rows: Checked[] = [];
  for (const row of rowsOf(await rangeOf(driver, table, after, seal))) {
    const checked = check(row, seal);
    if ('reason' in checked) return checked;
    rows.push(checked);
  }
  if (rows.length < seal.count) return tamper(seal, 'count', seal.fromSeq);
  const late = rows.length > seal.count ? lateRows(rows, seal) : new Set<number>();
  if (late === undefined) return tamper(seal, 'count', seal.fromSeq);
  const sealed = rows.filter((r) => !late.has(r.seq));
  if (
    late.size === 0 &&
    sealHash(
      seal.previousHash,
      seal.sealedAt,
      sealed.map((r) => r.digest),
    ) !== seal.hash
  )
    return tamper(seal, 'seal', seal.fromSeq);
  walk.uncovered.push(...uncoveredRows(late, 'late', seal));
  const redacted = sealed.filter((r) => r.redacted);
  walk.redactions.push(...redacted);
  walk.redacted += redacted.length;
  walk.intact += sealed.length - redacted.length;
  return undefined;
}

const keyOf = (subject: AuditSubject | undefined): string => JSON.stringify([subject?.type, subject?.id]);

/** The redacted events that no `erasure` record of their subject, at or after them, explains. */
async function unexplained(driver: OrmDriver, table: string, redactions: readonly Checked[]): Promise<number[]> {
  const subjects = [...new Map(redactions.flatMap((r) => (r.subject === undefined ? [] : [[keyOf(r.subject), r.subject] as const]))).values()];
  const erasedAt = new Map<string, number>();
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT per SUBJECT_CHUNK erased subjects
  for (let i = 0; i < subjects.length; i += SUBJECT_CHUNK) {
    const chunk = subjects.slice(i, i + SUBJECT_CHUNK);
    const select = driver.select().from(table).where('kind', 'custom').where('action', 'erasure');
    select.whereIn('subject_type', [...new Set(chunk.map((s) => s.type))]).whereIn('subject_id', [...new Set(chunk.map((s) => s.id))]);
    for (const erasure of rowsOf(await select).map(toStored)) {
      const key = keyOf(erasure.subject);
      erasedAt.set(key, Math.max(erasedAt.get(key) ?? Number.NEGATIVE_INFINITY, erasure.at.getTime()));
    }
  }
  return redactions.filter((r) => !(r.at <= (erasedAt.get(keyOf(r.subject)) ?? Number.NEGATIVE_INFINITY))).map((r) => r.seq);
}

interface Chain {
  readonly good: AuditSeal | undefined;
  readonly tampered: AuditTamper | undefined;
}

// A seal must chain from the one verified before it, and match a pinned head that ends where it ends.
function relink(seal: AuditSeal, good: AuditSeal | undefined, pinned: AuditPinnedHead | undefined): AuditTamper | undefined {
  const pinMismatch = seal.toSeq === pinned?.toSeq && seal.hash !== pinned.hash;
  return seal.previousHash !== (good?.hash ?? null) || pinMismatch ? tamper(seal, 'chain', seal.fromSeq) : undefined;
}

/** Walks the seal chain of one table from its first seal and stops at the first seal or event that does not match. */
async function walkChain(driver: OrmDriver, table: string, pinned: AuditPinnedHead | undefined, walk: Walk): Promise<Chain> {
  let good: AuditSeal | undefined;
  let met = pinned === undefined;
  // spinajs-orm-ignore ORM102: deliberate paging, one SELECT of seals per page and one SELECT of events per seal
  for (;;) {
    const page = await sealsAfter(driver, table, good?.toSeq ?? 0);
    for (const seal of page) {
      walk.seals += 1;
      const tampered = relink(seal, good, pinned) ?? (await checkSeal(driver, table, seal, good?.toSeq ?? 0, walk));
      if (tampered) return { good, tampered };
      met ||= seal.toSeq === pinned?.toSeq;
      good = seal;
    }
    if (page.length < SEAL_PAGE_SIZE) break;
  }
  // The pinned seal is gone, or the chain was rewritten with other range ends.
  return { good, tampered: met || !pinned ? undefined : { seq: pinned.toSeq, reason: 'chain', fromSeq: pinned.toSeq, toSeq: pinned.toSeq } };
}

/** Verifies the seal chain of one table. A pinned head, a copy kept outside the database, must be met on the way with the same hash. */
export async function verifyTable(driver: OrmDriver, table: string, pinned?: AuditPinnedHead): Promise<Omit<AuditVerifyReport, 'trail'>> {
  const walk: Walk = { seals: 0, intact: 0, redacted: 0, prunedSeals: 0, uncovered: [], redactions: [] };
  const { good, tampered } = await walkChain(driver, table, pinned, walk);
  const last = await lastSeal(driver, table);
  const { redactions, ...tally } = walk;
  return {
    connection: driver.Options.Name,
    table,
    ...tally,
    tampered,
    unsealed: await driver
      .select()
      .from(table)
      .where('seq', '>', last?.toSeq ?? 0)
      .selectCount(),
    head: good === undefined ? undefined : { toSeq: good.toSeq, hash: good.hash },
    unexplainedRedactions: await unexplained(driver, table, redactions),
  };
}
