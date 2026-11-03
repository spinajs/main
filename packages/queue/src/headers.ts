/** Header names every transport writes and reads the same way. `traceparent` is reserved for tracing. */
export const QueueHeaders = { MessageId: 'x-spinajs-message-id', RetryCount: 'x-retry-count', Error: 'x-error', OriginalDestination: 'x-original-destination', TraceParent: 'traceparent' } as const;

export type QueueHeaderName = (typeof QueueHeaders)[keyof typeof QueueHeaders];

const STANDARD_HEADERS: readonly string[] = Object.values(QueueHeaders);

/** The standard headers present in a broker's raw headers, as strings; broker-owned and unknown headers are left out. */
export function readQueueHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of STANDARD_HEADERS) {
    const value = raw?.[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[name] = String(value);
    }
  }
  return result;
}
