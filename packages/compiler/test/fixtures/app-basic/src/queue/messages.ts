import { Event, Job, QueueEvent, QueueJob } from '@spinajs/queue';

@Job()
export class SendMailJob extends QueueJob {
  public to!: string;
  public subject!: string;

  public async execute(): Promise<void> {}
}

@Event()
export class UserCreated extends QueueEvent {
  public id!: number;
}
