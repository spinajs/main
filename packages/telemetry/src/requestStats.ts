/**
 * Serializable snapshot of {@link RequestStats}.
 */
export interface IRequestStatsSnapshot {
  requests: number;
  responses: number;
  errors: number;

  info: number;
  success: number;
  redirect: number;
  client_error: number;
  server_error: number;

  total_time: number;
  max_time: number;
  min_time: number;
  avg_time: number;

  apdex_satisfied: number;
  apdex_tolerated: number;
  apdex_score: number;

  req_rate: number;
  err_rate: number;
}

const DEFAULT_APDEX_THRESHOLD_MS = 25;

/**
 * Port of swagger-stats' `swsReqResStats` — accumulates request/response
 * counters, response-time aggregates ( total / max / min / avg ), an Apdex
 * score, and request/error rates over its lifetime.
 *
 * Pure and dependency-free; time is always passed in so it is deterministic.
 */
export class RequestStats {
  /**
   * Apdex satisfied-response threshold, in milliseconds. Responses up to
   * `4 * threshold` are "tolerated".
   */
  public readonly apdexThreshold: number;

  // request/response counters
  public requests = 0;
  public responses = 0;
  public errors = 0;

  // status-class counters
  public info = 0;
  public success = 0;
  public redirect = 0;
  public client_error = 0;
  public server_error = 0;

  // response-time aggregates ( ms )
  public totalTime = 0;
  public maxTime = 0;
  public minTime = 0;
  public avgTime = 0;

  // apdex accumulators
  public apdexSatisfied = 0;
  public apdexTolerated = 0;

  // rates ( per second )
  public reqRate = 0;
  public errRate = 0;

  constructor(apdexThreshold: number = DEFAULT_APDEX_THRESHOLD_MS) {
    this.apdexThreshold = apdexThreshold;
  }

  /**
   * Count an inbound request ( before the response is known ).
   */
  public countRequest(): void {
    this.requests += 1;
  }

  /**
   * Count a completed response, updating status-class counters, response-time
   * aggregates and Apdex.
   *
   * @param statusCode - the HTTP status code of the response
   * @param durationMs - the request duration in milliseconds
   */
  public countResponse(statusCode: number, durationMs: number): void {
    this.responses += 1;

    // status class counters
    if (statusCode >= 100 && statusCode < 200) this.info += 1;
    else if (statusCode >= 200 && statusCode < 300) this.success += 1;
    else if (statusCode >= 300 && statusCode < 400) this.redirect += 1;
    else if (statusCode >= 400 && statusCode < 500) this.client_error += 1;
    else if (statusCode >= 500) this.server_error += 1;

    const isError = statusCode >= 400;
    if (isError) this.errors += 1;

    // response-time aggregates
    this.totalTime += durationMs;
    if (durationMs > this.maxTime) this.maxTime = durationMs;
    if (this.minTime === 0 || durationMs < this.minTime) this.minTime = durationMs;
    this.avgTime = this.responses > 0 ? this.totalTime / this.responses : 0;

    // Apdex — a "satisfactory" response is a non-error ( < 500 and not a
    // client/server error ). swagger-stats treats any error ( 4xx/5xx ) as
    // frustrating, so only 1xx/2xx/3xx responses can be satisfied/tolerated.
    const satisfactory = !isError;
    if (satisfactory) {
      if (durationMs <= this.apdexThreshold) this.apdexSatisfied += 1;
      else if (durationMs <= 4 * this.apdexThreshold) this.apdexTolerated += 1;
    }
  }

  /**
   * The current Apdex score: `(satisfied + tolerated/2) / responses`.
   * Returns 0 when there are no responses yet.
   */
  public apdex(): number {
    if (this.responses === 0) return 0;
    return (this.apdexSatisfied + this.apdexTolerated / 2) / this.responses;
  }

  /**
   * Recompute request/error rates ( per second ) over an elapsed window.
   *
   * @param elapsedMs - the width of the window in milliseconds
   */
  public updateRates(elapsedMs: number): void {
    if (elapsedMs <= 0) {
      this.reqRate = 0;
      this.errRate = 0;
      return;
    }
    const seconds = elapsedMs / 1000;
    this.reqRate = this.requests / seconds;
    this.errRate = this.errors / seconds;
  }

  /**
   * A plain-object snapshot of the current stats.
   */
  public toJSON(): IRequestStatsSnapshot {
    return {
      requests: this.requests,
      responses: this.responses,
      errors: this.errors,

      info: this.info,
      success: this.success,
      redirect: this.redirect,
      client_error: this.client_error,
      server_error: this.server_error,

      total_time: this.totalTime,
      max_time: this.maxTime,
      min_time: this.minTime,
      avg_time: this.avgTime,

      apdex_satisfied: this.apdexSatisfied,
      apdex_tolerated: this.apdexTolerated,
      apdex_score: this.apdex(),

      req_rate: this.reqRate,
      err_rate: this.errRate,
    };
  }
}
