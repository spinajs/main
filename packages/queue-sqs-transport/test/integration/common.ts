import { FrameworkConfiguration } from '@spinajs/configuration';

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
export const SQS_REGION = process.env.SQS_REGION ?? 'us-east-1';
export const SQS_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

/**
 * Base test configuration for the SQS transport. Mirrors the idiom used by the
 * other queue transports ( see queue-amqp-transport/test ) - a `queue` block and
 * a BlackHole logger so tests stay quiet.
 *
 * The routing table is filled in at runtime once the queue is created against
 * localstack ( the URL is only known then ), so here we just wire up the logger
 * and an empty routing table.
 */
export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      queue: {
        routing: {},
        connections: [
          {
            service: 'SqsQueueClient',
            name: 'sqs',
            options: {
              region: SQS_REGION,
              endpoint: SQS_ENDPOINT,
              credentials: SQS_CREDENTIALS,
            },
          },
        ],
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}
