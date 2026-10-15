import type { IMessageRoutingOption, IQueueConfiguration } from '@spinajs/queue';

export type QueueRoutingConfig = Partial<Pick<IQueueConfiguration, 'default' | 'routing'>> & {
  connections?: Array<{ name: string; service?: string }>;
};

/**
 * Connections a job named `jobName` is sent to, resolved like `QueueService.getConnectionsForMessage`
 * (which is protected): a string route is a channel on the default connection.
 */
export function jobConnections(jobName: string, queue: QueueRoutingConfig): string[] {
  const route = new Map(Object.entries(queue.routing ?? {})).get(jobName);
  const fallback = queue.default ?? '';
  if (route === undefined || typeof route === 'string') return [fallback];
  const options = (Array.isArray(route) ? route : [route]) as Array<string | IMessageRoutingOption>;
  return [...new Set(options.map((o) => (typeof o === 'string' ? fallback : o.connection ?? fallback)))];
}

export function blackHoleConnections(jobName: string, queue: QueueRoutingConfig): string[] {
  return jobConnections(jobName, queue).filter(
    (name) => queue.connections?.find((c) => c.name === name)?.service === 'BlackHoleQueueClient',
  );
}
