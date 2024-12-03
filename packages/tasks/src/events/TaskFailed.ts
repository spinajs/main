import { Event, QueueEvent } from '@spinajs/queue';
 

@Event()
export class TaskFailed extends QueueEvent {
    public TaskName: string;
    public Reason: string;
}
