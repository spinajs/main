import { Job, QueueJob } from '@spinajs/queue';

const tenancyMode = (): 'carry' | 'none' => 'carry';

@Job({ tenancy: tenancyMode() })
export class Rebalance extends QueueJob { public async execute(): Promise<void> {} }
