import type { ISseEvent } from '@spinajs/http';
import { isTerminalEvent, isTerminalStatus, RunEvent, RunInfo, SchedulerService, sseEventId, SubscribeTarget } from '@spinajs/scheduler';

export interface IEventSink {
  readonly Closed: boolean;
  send(event: ISseEvent): void;
  close(): void;
  onClose(callback: () => void): void;
}

export type RunEventSource = Pick<SchedulerService, 'subscribe'>;

/**
 * Same id / event / data triple the core's formatSseEvent() writes. Events at or below the last
 * position sent are dropped in case the replay and the live feed hand over the same event, except
 * synthetic progress, which repeats the last position on purpose (core R16).
 */
async function pipe(sink: IEventSink, source: RunEventSource, target: SubscribeTarget, after: number | undefined, closeOnTerminal: boolean): Promise<void> {
  const position = (event: RunEvent) => ('runId' in target ? event.seq : event.id);
  let last = after ?? -1;

  const unsubscribe = await source.subscribe(
    target,
    (event) => {
      const synthetic = event.type === 'progress' && event.synthetic === true;
      if (sink.Closed || (!synthetic && position(event) <= last)) {
        return;
      }

      if (!synthetic) {
        last = position(event);
      }
      sink.send({ id: sseEventId(target, event), event: event.type, data: event });

      if (closeOnTerminal && isTerminalEvent(event)) {
        sink.close();
      }
    },
    after === undefined ? {} : { after },
  );

  sink.onClose(unsubscribe);
}

export async function streamRunEvents(sink: IEventSink, source: RunEventSource, run: Pick<RunInfo, 'id' | 'status'>, after: number): Promise<void> {
  await pipe(sink, source, { runId: run.id }, after, true);

  if (isTerminalStatus(run.status) && !sink.Closed) {
    sink.close();
  }
}

export async function streamScheduleEvents(sink: IEventSink, source: RunEventSource, schedule: string, after: number | undefined): Promise<void> {
  await pipe(sink, source, { schedule }, after, false);
}
