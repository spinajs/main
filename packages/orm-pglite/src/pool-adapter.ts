import { types as pgliteTypes, type PGlite, type ParserOptions, type Results } from '@electric-sql/pglite';
import { utcTypeParser } from '@spinajs/orm-postgres';
import pgUtils from 'pg/lib/utils';

/** The part of a node-postgres `QueryResult` the postgres driver reads. */
export interface PgliteQueryResult {
  rows: unknown[];
  rowCount: number;
  command: string;
  fields: Array<{ name: string; dataTypeID: number }>;
}

// Built-in types have OIDs below this; every parser pg or PGlite ships is for one of them.
const FIRST_USER_OID = 16384;

const ENDED = 'Cannot use a pool after calling end on the pool';

/**
 * One parser for every OID that pg or PGlite would parse, each the one the postgres driver's pool uses. It is passed
 * with every query, so it also overrides the array parsers PGlite installs for itself at startup.
 */
export async function pgCompatibleParsers(db: PGlite): Promise<ParserOptions> {
  const noParse = utcTypeParser(0, 'text');
  const oids = new Set<number>();

  for (const key of Object.keys(pgliteTypes.parsers)) {
    const oid = Number(key);
    if (Number.isInteger(oid)) {
      oids.add(oid);
    }
  }

  for (let oid = 1; oid < FIRST_USER_OID; oid++) {
    if (utcTypeParser(oid, 'text') !== noParse) {
      oids.add(oid);
    }
  }

  const arrays = await db.query<{ typarray: number }>('SELECT typarray FROM pg_type WHERE typarray <> 0');
  for (const { typarray } of arrays.rows) {
    oids.add(typarray);
  }

  const parsers: ParserOptions = {};
  for (const oid of oids) {
    parsers[oid] = utcTypeParser(oid, 'text');
  }

  return parsers;
}

function toPgResult(result: Results<Record<string, unknown>>): PgliteQueryResult {
  return {
    rows: result.rows,
    // rowCount is per statement, like pg's; affectedRows adds up every statement of one exec().
    rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
    command: result.command ?? '',
    fields: result.fields,
  };
}

/** One lease of the PGlite session, shaped like a pg `PoolClient`. */
export class PglitePoolClient {
  private released = false;

  public constructor(
    private readonly db: PGlite,
    private readonly parsers: ParserOptions,
    private readonly onRelease: () => void,
  ) {}

  public async query(text: string, params: unknown[] = []): Promise<PgliteQueryResult | PgliteQueryResult[]> {
    if (params.length === 0) {
      // pg sends a statement without values over the simple protocol, which runs several statements and answers
      // with one result each; PGlite's query() refuses several statements.
      const results = (await this.db.exec(text, { parsers: this.parsers })).map(toPgResult);
      return results.length === 1 ? results[0] : results;
    }

    // Serialized by pg's own rules, so a value means on PGlite what it means on a server.
    const values = params.map((p) => pgUtils.prepareValue(p));
    return toPgResult(await this.db.query<Record<string, unknown>>(text, values, { parsers: this.parsers }));
  }

  public release(): void {
    if (this.released) {
      throw new Error('Release called on client which has already been released to the pool.');
    }

    this.released = true;
    this.onRelease();
  }

  /** There is no socket to fail between statements; an error reaches the statement that caused it. */
  public on(): this {
    return this;
  }
}

interface Waiter {
  grant(client: PglitePoolClient): void;
  fail(err: Error): void;
}

/**
 * A pg.Pool over the one PGlite session: one client at a time, in request order. A transaction holds its client from
 * BEGIN to COMMIT, so no other statement interleaves with it.
 */
export class PglitePool {
  public readonly totalCount = 1;

  private busy = false;
  private ended = false;
  private readonly waiting: Waiter[] = [];

  public constructor(
    private readonly db: PGlite,
    private readonly parsers: ParserOptions,
    private readonly acquireTimeout: number,
  ) {}

  public get idleCount(): number {
    return this.busy ? 0 : 1;
  }

  public get waitingCount(): number {
    return this.waiting.length;
  }

  public connect(): Promise<PglitePoolClient> {
    if (this.ended) {
      return Promise.reject(new Error(ENDED));
    }

    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(this.client());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new Error(`timeout exceeded when trying to connect: the PGlite session stayed busy for ${this.acquireTimeout} ms`));
      }, this.acquireTimeout);
      const waiter: Waiter = {
        grant: (client) => {
          clearTimeout(timer);
          resolve(client);
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      this.waiting.push(waiter);
    });
  }

  public on(): this {
    return this;
  }

  /** Taken under a lease, so it never captures half of a transaction. */
  public async dumpDataDir(): Promise<Blob> {
    const client = await this.connect();
    try {
      return await this.db.dumpDataDir('none');
    } finally {
      client.release();
    }
  }

  public async end(): Promise<void> {
    if (this.ended) {
      return;
    }

    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.fail(new Error(ENDED));
    }

    await this.db.close();
  }

  private client(): PglitePoolClient {
    return new PglitePoolClient(this.db, this.parsers, () => this.handOver());
  }

  private handOver(): void {
    const next = this.waiting.shift();
    if (next) {
      next.grant(this.client());
    } else {
      this.busy = false;
    }
  }
}
