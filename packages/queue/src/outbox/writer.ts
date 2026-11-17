import { Config } from '@spinajs/configuration';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { DbClock, FaultInjector } from '@spinajs/durable';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Orm, type OrmDriver } from '@spinajs/orm';
import { isCrash } from '../crash.js';
import type { IQueueMessage } from '../interfaces.js';
import { outboxConfig, type IQueueOutboxConfig } from './config.js';
import { OutboxAmbiguousTransaction, OutboxConnectionNotCovered, OutboxMessageIdConflict } from './errors.js';
import { inRootContext } from './root-context.js';
import { newOutboxRow, OUTBOX_MESSAGE_ID_MAX } from './row.js';
import { OutboxStore } from './store.js';
import { assertInsertOrIgnore, outboxTargets, type OutboxTarget } from './targets.js';

/** How old the database time offset may get before an emit has it read again; a process without a relay has nothing else that reads it. */
const RESYNC_AFTER_MS = 60_000;

interface OutboxConnections {
  targets: OutboxTarget[];
  /** Every other ORM driver: a transaction open on one of them cannot carry an outbox row. */
  uncovered: OrmDriver[];
}

@Singleton()
@Injectable()
export class OutboxWriter {
  @Logger('queue')
  protected Log: Log;

  @Config('queue.outbox')
  protected Raw: Partial<IQueueOutboxConfig> | undefined;

  @Autoinject(DbClock)
  protected Time: DbClock;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  protected config?: IQueueOutboxConfig;
  protected connections?: OutboxConnections;
  protected synced?: Promise<number>;
  protected syncedAt = 0;

  public get Config(): IQueueOutboxConfig {
    return (this.config ??= outboxConfig(this.Raw));
  }

  /** The check QueueOutboxMigrationSource makes in the Orm's boot, again: an Orm that resolved before this package was imported never asked that source. */
  public async ready(): Promise<void> {
    if (!this.Config.enabled) return;
    for (const target of (await this.allConnections()).targets) assertInsertOrIgnore(target);
    try {
      await this.syncTime();
    } catch (error) {
      if (isCrash(error)) throw error;
      throw new InvalidOperation('queue.outbox: database time could not be read. @spinajs/durable reads it from the ORM connection "default", so an app that enables the outbox sets db.DefaultConnection', error);
    }
  }

  /** The target the message was written to, or undefined when the caller must publish it directly. */
  public async enlistOn(message: IQueueMessage): Promise<OutboxTarget | undefined> {
    if (!this.Config.enabled) return undefined;
    const messageId = message.MessageId;
    if (!messageId) throw new TypeError('OutboxWriter.enlistOn: the message has no MessageId; emit() assigns it first');

    const target = this.targetOf(await this.allConnections());
    if (!target) return undefined;

    if (messageId.length > OUTBOX_MESSAGE_ID_MAX) {
      throw new InvalidArgument(`queue.emit(): MessageId is ${messageId.length} characters long; the outbox holds at most ${OUTBOX_MESSAGE_ID_MAX}`);
    }
    await this.syncTime();
    const store = new OutboxStore(target.driver);
    if (!(await store.insert(newOutboxRow(message, messageId, this.Time.now())))) {
      await this.duplicate(store, message, messageId);
    }
    await this.Faults.point('outbox.after-insert', { messageId, connection: target.connection });
    return target;
  }

  public async enlist(message: IQueueMessage): Promise<boolean> {
    return (await this.enlistOn(message)) !== undefined;
  }

  protected targetOf({ targets, uncovered }: OutboxConnections): OutboxTarget | undefined {
    const open = targets.filter((t) => t.driver.CurrentTransaction !== undefined);
    if (open.length > 1) throw new OutboxAmbiguousTransaction(open.map((t) => t.connection));
    if (open.length === 0) {
      const outside = uncovered.filter((driver) => driver.CurrentTransaction !== undefined);
      if (outside.length > 0) throw new OutboxConnectionNotCovered(outside.map((driver) => driver.Options.Name));
    }
    return open[0] ?? (this.Config.mode === 'always' ? targets[0] : undefined);
  }

  /**
   * A repeat of the same message is normal (a retried business transaction) and returns. Any other row under this id
   * will never publish the message being emitted, so the caller must not be told it was written.
   */
  protected async duplicate(store: OutboxStore, message: IQueueMessage, messageId: string): Promise<void> {
    const existing = await store.find(messageId);
    if (!existing) {
      throw new OutboxMessageIdConflict(
        messageId,
        'this transaction cannot read that row: it was committed after the transaction began (REPEATABLE READ on MySQL and Postgres), so retry the transaction; or its id differs from this one only in trailing spaces, which MySQL and SQL Server compare as equal, so emit with a new MessageId',
      );
    }
    if (existing.Name !== message.Name || existing.Type !== String(message.Type)) {
      throw new OutboxMessageIdConflict(messageId, `that row is the ${existing.Type} ${existing.Name}, not the ${message.Type} ${message.Name}`);
    }
    if (existing.Status === 'dead') {
      throw new OutboxMessageIdConflict(messageId, 'that row is dead and will never be published; re-drive or delete the row, or emit with a new MessageId');
    }
  }

  /** Rows carry database time, which the relay compares AvailableAt with. */
  protected async syncTime(): Promise<void> {
    const now = this.Time.now();
    if (this.synced === undefined) {
      this.syncedAt = now;
      // a failed sync is tried again by the next emit, not remembered
      this.synced = this.Time.sync().catch((error: unknown) => {
        this.synced = undefined;
        throw error;
      });
    } else if (now - this.syncedAt >= RESYNC_AFTER_MS) {
      this.syncedAt = now;
      this.resync();
    }
    await this.synced;
  }

  // Not awaited, and outside the emitter's context: the emit may run in a transaction on `default`, which a failed read
  // would abort on Postgres. Until the read returns, rows carry the previous offset.
  protected resync(): void {
    inRootContext(() => {
      this.Time.sync().catch((error: unknown) => this.Log.warn({ error }, 'The outbox could not read database time again; rows keep the previous offset'));
    });
  }

  protected async allConnections(): Promise<OutboxConnections> {
    if (!this.connections) {
      const orm = await DI.resolve(Orm);
      const targets = outboxTargets(orm, this.Config.connections);
      const covered = new Set(targets.map((t) => t.driver));
      // Orm.Connections lists one driver under several names (`default`, aliases)
      const uncovered = [...new Set(orm.Connections.values())].filter((driver) => !covered.has(driver));
      this.connections = { targets, uncovered };
    }
    return this.connections;
  }
}
