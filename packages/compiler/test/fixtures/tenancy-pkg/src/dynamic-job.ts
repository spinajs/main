import { Job, QueueJob } from '@spinajs/queue';

const tenancyMode = (): 'carry' | 'none' => 'carry';

@Job({ tenancy: tenancyMode() })
export class Rebalance extends QueueJob { public async execute(): Promise<void> {} }

const perms = (): string[] => ['ledger.write'];

@Job({ access: perms() })
export class Reindex extends QueueJob { public async execute(): Promise<void> {} }

const JOB_OPTIONS = { tenancy: 'required' } as const;

@Job(JOB_OPTIONS)
export class Settle extends QueueJob { public async execute(): Promise<void> {} }

const NONE: { tenancy?: 'none' } = { tenancy: 'none' };

@Job({ tenancy: 'required', ...NONE })
export class Archive extends QueueJob { public async execute(): Promise<void> {} }
