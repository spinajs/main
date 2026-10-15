import { expect } from 'chai';
import { IQueueConnectionOptions } from '@spinajs/queue';
import { defaultClientId } from '../src/connection-factory.js';

describe('stomp connection factory - client-id', () => {
  it('keeps an explicit clientId', () => {
    expect(defaultClientId({ name: 'jobs', clientId: 'mine' } as IQueueConnectionOptions, 'app', 'production')).to.eq('mine');
  });

  it('derives app-env-name when no clientId is configured', () => {
    expect(defaultClientId({ name: 'jobs' } as IQueueConnectionOptions, 'app', 'production')).to.eq('app-production-jobs');
  });
});
