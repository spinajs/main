import { Config } from '@spinajs/configuration';
import { Injectable, Singleton, SyncService } from '@spinajs/di';
import { StrToLogLevel } from '@spinajs/log';

import type { StudioLogLine } from '../contracts/index.js';
import { RingBuffer } from './ring.js';

const DEFAULT_LIMIT = 200;
const LEVELS = new Map<string, number>(Object.entries(StrToLogLevel));
const NO_REDACTION: ReadonlySet<string> = new Set();

const rank = (level: string): number => LEVELS.get(level) ?? -1;

/** The last `studio.buffers.logs` lines that carry a trace id or are warnings and above. */
@Singleton()
@Injectable()
export class LogStore extends SyncService {
  @Config('studio.buffers.logs', { defaultValue: 5000 })
  protected Capacity: number;

  @Config('studio.redactAttributes', { defaultValue: [] })
  protected Redact: string[];

  private ring?: RingBuffer<StudioLogLine>;
  private redactSet?: ReadonlySet<string>;

  /** `capacity` and `redact` are for tests; DI constructs the store without arguments. */
  public constructor(capacity?: number, redact?: readonly string[]) {
    super();
    if (capacity !== undefined) this.ring = new RingBuffer(capacity);
    if (redact) this.redactSet = new Set(redact);
  }

  public resolve(): void {
    super.resolve();
    this.ring ??= new RingBuffer(this.Capacity);
    this.redactSet ??= new Set(this.Redact);
  }

  /** `studio.redactAttributes`, applied to log fields as to span attributes. */
  public get redact(): ReadonlySet<string> {
    return this.redactSet ?? NO_REDACTION;
  }

  public add(line: StudioLogLine): void {
    this.ring?.push(line);
  }

  /** Newest first. */
  public query(q: { traceId?: string; level?: string; limit?: number }): StudioLogLine[] {
    const min = q.level === undefined ? -Infinity : rank(q.level);
    return this.lines()
      .reverse()
      .filter((l) => (q.traceId === undefined || l.traceId === q.traceId) && rank(l.level) >= min)
      .slice(0, q.limit ?? DEFAULT_LIMIT);
  }

  /** Oldest first, as a waterfall reads them. */
  public forTrace(traceId: string): StudioLogLine[] {
    return this.lines().filter((l) => l.traceId === traceId);
  }

  public async dispose(): Promise<void> {
    this.ring?.clear();
  }

  private lines(): StudioLogLine[] {
    return this.ring?.toArray() ?? [];
  }
}
