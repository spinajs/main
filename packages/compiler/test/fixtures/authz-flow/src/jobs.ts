import { Job, QueueJob } from '@spinajs/queue';
import { resolvedOverdue } from './services.js';

@Job({ access: 'invoice:read', runAs: 'initiator' })
export class OverdueJob extends QueueJob {
  public async execute() {
    return resolvedOverdue();
  }
}
