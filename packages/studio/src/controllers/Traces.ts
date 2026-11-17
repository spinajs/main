import { Autoinject } from '@spinajs/di';
import { CodedHttpException, ResourceNotFound } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, Ok, SseResponse } from '@spinajs/http';

import { LogStore } from '../buffers/log-store.js';
import { TraceStore } from '../buffers/trace-store.js';
import type { TraceDetail } from '../contracts/index.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { TraceIdParam, TraceQueryArg, traceQuery } from '../queries/traces.js';

/** A stream is closed after this long; `EventSource` reconnects, and the access policy runs again. */
export const TRACE_STREAM_MAX_MS = 15 * 60_000;
export const MAX_TRACE_STREAMS = 16;

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioTracesController extends BaseController {
  @Autoinject(TraceStore)
  protected Traces: TraceStore;

  @Autoinject(LogStore)
  protected Logs: LogStore;

  private streams = 0;

  /**
   * Buffered traces, newest first.
   *
   * @returns {StudioPage} Trace summaries and the cursor of the next page
   */
  @Get('api/traces')
  @StudioAccess('traces')
  public async list(
    @TraceQueryArg('route') route?: string,
    @TraceQueryArg('name') name?: string,
    @TraceQueryArg('status') status?: string,
    @TraceQueryArg('minDurationMs') minDurationMs?: number,
    @TraceQueryArg('principalId') principalId?: string,
    @TraceQueryArg('from') from?: string,
    @TraceQueryArg('to') to?: string,
    @TraceQueryArg('limit') limit?: number,
    @TraceQueryArg('cursor') cursor?: string,
  ) {
    return new Ok(this.Traces.list(traceQuery({ route, name, status, minDurationMs, principalId, from, to, limit, cursor })));
  }

  // Declared before `api/traces/:traceId`, which would otherwise take `stream` as an id.
  /**
   * Server-sent `trace` events, one per finished root span; data is the trace summary.
   */
  @Get('api/traces/stream')
  @StudioAccess('traces')
  public async stream() {
    if (this.streams >= MAX_TRACE_STREAMS) {
      throw new CodedHttpException(503, 'studio.trace_streams', `at most ${MAX_TRACE_STREAMS} trace streams are open at once`);
    }
    return new SseResponse((stream, req) => {
      this.streams++;
      // A client that stopped reading would make Node buffer every event; it catches up on the next one it takes.
      const off = this.Traces.subscribe((summary) => {
        if (req.res?.writableNeedDrain) return;
        stream.send({ id: summary.traceId, event: 'trace', data: summary });
      });
      // Access is checked when the stream opens; the cap bounds how long a caller who lost it keeps reading.
      const expiry = setTimeout(() => stream.close(), TRACE_STREAM_MAX_MS);
      expiry.unref();
      stream.onClose(() => {
        clearTimeout(expiry);
        off();
        this.streams--;
      });
    });
  }

  /**
   * One buffered trace with its spans and log lines.
   *
   * @returns {TraceDetail} Summary, spans, logs and whether spans were dropped
   * @response 404 The trace is not in the Studio buffer
   */
  @Get('api/traces/:traceId')
  @StudioAccess('traces')
  public async detail(@TraceIdParam() traceId: string) {
    const found = this.Traces.get(traceId);
    if (!found) throw new ResourceNotFound(`trace ${traceId} is not in the Studio buffer`);
    const detail: TraceDetail = { ...found, logs: this.Logs.forTrace(traceId) };
    return new Ok(detail);
  }
}
