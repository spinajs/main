import { InvalidOperation } from '@spinajs/exceptions';

export class OutboxAmbiguousTransaction extends InvalidOperation {
  constructor(public readonly connections: string[]) {
    super(`queue.emit(): transactions are open on several outbox connections (${connections.join(', ')}); emit inside one of them only`);
    this.name = 'OutboxAmbiguousTransaction';
  }
}

export class OutboxConnectionNotCovered extends InvalidOperation {
  constructor(public readonly connections: string[]) {
    const names = connections.map((c) => `"${c}"`).join(', ');
    super(`queue.emit(): a transaction is open on ORM connection ${names}, which queue.outbox.connections does not list, so the message could not roll back with it. Add ${names} to queue.outbox.connections, or emit from afterCommit()`);
    this.name = 'OutboxConnectionNotCovered';
  }
}

/** The outbox holds this MessageId in a row that will not publish the message being emitted. */
export class OutboxMessageIdConflict extends InvalidOperation {
  constructor(
    public readonly messageId: string,
    reason: string,
  ) {
    super(`queue.emit(): the outbox already holds MessageId ${messageId}, and ${reason}; this message was not written`);
    this.name = 'OutboxMessageIdConflict';
  }
}
