import { DI, Injectable, NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { LogTarget } from '@spinajs/log';
import type { ICommonTargetOptions, ILogEntry, LogLevel } from '@spinajs/log';
import { QueueClient } from '@spinajs/queue';
import type { IQueueMessage, QueueMessage } from '@spinajs/queue';

export interface CapturedMessage {
  readonly message: IQueueMessage;
  /** Whether a transaction was in scope on the emitting async path; an event must follow its commit (spec §6.6). */
  readonly inTransaction: boolean;
}

/** In-memory transport, as queue/test/core.test.ts:19-38. A name in FailNames makes its emit reject. */
@NewInstance()
@Injectable(QueueClient)
export class CaptureQueueClient extends QueueClient {
  public static readonly Captured: CapturedMessage[] = [];
  public static readonly FailNames = new Set<string>();
  public static Probe: () => boolean = () => false;

  public static reset(): void {
    CaptureQueueClient.Captured.length = 0;
    CaptureQueueClient.FailNames.clear();
  }

  public emit(message: IQueueMessage): Promise<void> {
    if (CaptureQueueClient.FailNames.has(message.Name)) {
      return Promise.reject(new Error(`emit of ${message.Name} refused by the test`));
    }
    CaptureQueueClient.Captured.push({ message, inTransaction: CaptureQueueClient.Probe() });
    return Promise.resolve();
  }

  public subscribe(_channel: string | Constructor<QueueMessage>, _callback: (e: IQueueMessage) => Promise<void>): Promise<void> {
    return Promise.resolve();
  }

  public unsubscribe(): void {}
}

/** An emitted event, with its own fields (Part, Code, …) readable in assertions. */
export type CapturedEvent = IQueueMessage & Record<string, any>;

export const emitted = (name?: string): CapturedEvent[] => CaptureQueueClient.Captured.map((c) => c.message as CapturedEvent).filter((m) => name === undefined || m.Name === name);

export const emittedNames = (): string[] => emitted().map((m) => m.Name);

export class CaptureLogTarget extends LogTarget<ICommonTargetOptions> {
  public static readonly Entries: ILogEntry[] = [];

  public static reset(): void {
    CaptureLogTarget.Entries.length = 0;
  }

  public write(entry: ILogEntry): void {
    CaptureLogTarget.Entries.push(entry);
  }
}

// Log targets are resolved by their `type` string (log/test/perf-sink.test.ts:40).
DI.register(CaptureLogTarget).as('CaptureLogTarget');

export const uploadLogs = (level?: LogLevel): ILogEntry[] => CaptureLogTarget.Entries.filter((e) => e.Variables.logger === 'upload' && (level === undefined || e.Level === level));
