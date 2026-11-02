import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('via-import', { every: '1h' })
export class ViaImportTask extends ScheduledTask {}
