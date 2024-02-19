import { IQueueMessage, QueueEvent, QueueJob, QueueService } from './interfaces.js';
import { _chain } from '@spinajs/util';
import { _resolve } from '@spinajs/di';

export function _ev(event: IQueueMessage | QueueEvent | QueueJob): () => Promise<void> {
  return () => _chain(
    _resolve(QueueService),
    (service: QueueService) => service.emit(event)
  );
}
