import { Event, QueueEvent } from '@spinajs/queue';

@Event({ durable: true })
export class UserCreated extends QueueEvent { public userId: number; public email: string }
