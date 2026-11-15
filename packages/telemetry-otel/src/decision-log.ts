import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Logger } from '@opentelemetry/api-logs';
import { DecisionLog, DecisionTraceContext, resourceKey } from '@spinajs/authz';
import type { DecisionRecord } from '@spinajs/authz';
import { Singleton } from '@spinajs/di';

/** The span attribute naming the decision a span made (G13). */
export const SPINA_AUTHZ_DECISION_ID = 'spina.authz.decision_id';

/**
 * Emits each decision record as an OTel log record through the global LoggerProvider (`logs.getLogger`); the app's
 * provider and exporter (OTLP or another) decide where they go, and without one the records are dropped by the API's
 * no-op logger. Not registered by importing it: the app registers it as the `DecisionLog`.
 */
@Singleton()
export class OtelDecisionLog extends DecisionLog {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    super();
    this.logger = logger ?? logs.getLogger('@spinajs/authz');
  }

  write(records: DecisionRecord[]): Promise<void> {
    for (const r of records) {
      this.logger.emit({
        timestamp: new Date(r.at),
        severityNumber: r.allowed ? SeverityNumber.INFO : SeverityNumber.WARN,
        severityText: r.allowed ? 'INFO' : 'WARN',
        body: `authz decision ${r.allowed ? 'allow' : 'deny'} ${r.permission} on ${resourceKey(r.resource)}`,
        attributes: {
          [SPINA_AUTHZ_DECISION_ID]: r.id,
          'spina.authz.domain': r.domain,
          'spina.authz.principal': r.principal,
          ...(r.actor === undefined ? {} : { 'spina.authz.actor': r.actor }),
          'spina.authz.permission': r.permission,
          'spina.authz.resource': resourceKey(r.resource),
          'spina.authz.allowed': r.allowed,
          ...(r.reason === undefined ? {} : { 'spina.authz.reason': r.reason }),
          'spina.authz.cached': r.cached,
          'spina.authz.policy_hash': r.policyHash,
          'spina.authz.inputs_hash': r.inputsHash,
          ...(r.traceId === undefined ? {} : { trace_id: r.traceId }),
          ...(r.spanId === undefined ? {} : { span_id: r.spanId }),
        },
      });
    }
    return Promise.resolve();
  }
}

/**
 * The active OTel span of a decision, read through the OTel API: it sees a span only where a context manager is
 * registered (the app's, or the SpinaJS tracing that installs one).
 */
@Singleton()
export class OtelDecisionTraceContext extends DecisionTraceContext {
  current(): { readonly traceId: string; readonly spanId: string } | undefined {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const { traceId, spanId } = span.spanContext();
    return { traceId, spanId };
  }

  annotate(decisionId: string): void {
    trace.getActiveSpan()?.setAttribute(SPINA_AUTHZ_DECISION_ID, decisionId);
  }
}
