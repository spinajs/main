import 'mocha';
import { describeQueueTransportConformance, EVENT_FAN_OUT_CASE } from '@spinajs/queue/testing';
import { localstackReachable, sqsHarness } from './harness.js';

describe('sqs conformance on localstack: standard queues', function () {
  before(async function () {
    if (!(await localstackReachable())) this.skip();
  });

  describeQueueTransportConformance('sqs standard (localstack)', () => sqsHarness({ fifo: false }), {
    skip: { [EVENT_FAN_OUT_CASE]: 'SQS has no topic fan-out: one queue per URL, one poll loop per queue' },
  });
});
