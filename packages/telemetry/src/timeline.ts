import { IRequestStatsSnapshot, RequestStats } from './requestStats.js';

/**
 * Serializable snapshot of a {@link Timeline}: a map of bucket-key -> stats.
 */
export type ITimelineSnapshot = Record<string, IRequestStatsSnapshot>;

const DEFAULT_LENGTH = 60;
const DEFAULT_BUCKET_MS = 60_000;

/**
 * Port of swagger-stats' `swsTimeline` — a rolling ring of `length` buckets,
 * each spanning `bucketMs`, keyed by `floor(timestamp / bucketMs)`. Each bucket
 * holds its own {@link RequestStats}.
 *
 * Deterministic: every method takes the current timestamp so tests can drive
 * it without touching the real clock.
 */
export class Timeline {
  /**
   * Number of buckets retained in the ring.
   */
  public readonly length: number;

  /**
   * Bucket width in milliseconds.
   */
  public readonly bucketMs: number;

  /**
   * Apdex threshold ( ms ) propagated to each bucket's RequestStats.
   */
  public readonly apdexThreshold: number;

  private buckets = new Map<number, RequestStats>();

  constructor(length: number = DEFAULT_LENGTH, bucketMs: number = DEFAULT_BUCKET_MS, apdexThreshold?: number) {
    this.length = length;
    this.bucketMs = bucketMs;
    this.apdexThreshold = apdexThreshold ?? new RequestStats().apdexThreshold;
  }

  /**
   * The bucket key for a timestamp.
   */
  public keyFor(timestamp: number): number {
    return Math.floor(timestamp / this.bucketMs);
  }

  private ensureBucket(key: number): RequestStats {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new RequestStats(this.apdexThreshold);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Open the bucket for `now` and expire buckets older than `length` buckets.
   */
  public tick(now: number = Date.now()): void {
    this.ensureBucket(this.keyFor(now));
    this.expire(now);
  }

  private expire(now: number): void {
    const oldest = this.keyFor(now) - this.length + 1;
    for (const key of [...this.buckets.keys()]) {
      if (key < oldest) this.buckets.delete(key);
    }
  }

  /**
   * Route a completed response into the bucket for its timestamp ( ticking to
   * open the current bucket + expire old ones first ).
   */
  public record(statusCode: number, durationMs: number, timestamp: number = Date.now()): void {
    this.tick(timestamp);
    const bucket = this.ensureBucket(this.keyFor(timestamp));
    bucket.countRequest();
    bucket.countResponse(statusCode, durationMs);
  }

  /**
   * A plain-object snapshot of every live bucket, keyed by bucket key. Rates
   * are per-second over the bucket width. When `now` is given, stale buckets
   * are expired against it first, so an idle period does not leave them visible.
   */
  public toJSON(now?: number): ITimelineSnapshot {
    if (now !== undefined) this.expire(now);
    const out: ITimelineSnapshot = {};
    for (const [key, stats] of this.buckets) {
      stats.updateRates(this.bucketMs);
      out[String(key)] = stats.toJSON();
    }
    return out;
  }
}
