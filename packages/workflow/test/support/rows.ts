import { jsonColumn, WorkflowEventModel, WorkflowInstanceModel, WorkflowStepModel } from '../../src/index.js';

/** The FakeClock's start in bootTestEnv. */
export const T0 = Date.parse('2026-11-10T10:00:00.000Z');

const JSON_FIELDS = new Set(['Input', 'Result', 'Error', 'Meta', 'Payload']);

/** `create()` reads a string as JSON text, so JSON columns are handed over serialized. */
const encode = (over: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(over).map(([k, v]) => [k, JSON_FIELDS.has(k) ? jsonColumn(v) : v]));

/** An override of `undefined` leaves the column out of the insert, so the column default applies. */
const omitUndefined = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

export const seedInstance = (id: string, over: Record<string, unknown> = {}): Promise<WorkflowInstanceModel> =>
  WorkflowInstanceModel.create(
    omitUndefined({
      Id: id,
      Workflow: 'test',
      Version: 1,
      Status: 'running',
      Reason: null,
      Input: null,
      Result: null,
      Error: null,
      WakeAt: null,
      WaitingFor: null,
      Attempt: 0,
      ClaimedBy: null,
      ClaimedUntil: null,
      ClaimEpoch: 0,
      CancelRequested: false,
      CreatedAt: T0,
      UpdatedAt: T0,
      FinishedAt: null,
      ...encode(over),
    }),
  );

export const seedStep = (instanceId: string, seq: number, key: string, over: Record<string, unknown> = {}): Promise<WorkflowStepModel> =>
  WorkflowStepModel.create({
    InstanceId: instanceId,
    Seq: seq,
    Key: key,
    Kind: key.split(':')[0],
    Status: 'succeeded',
    Attempt: 1,
    Result: null,
    ResultStored: false,
    Error: null,
    Meta: null,
    StartedAt: T0,
    FinishedAt: T0,
    ...encode(over),
  } as Partial<WorkflowStepModel>);

export const seedEvent = (instanceId: string, name: string, over: Record<string, unknown> = {}): Promise<WorkflowEventModel> =>
  WorkflowEventModel.create({
    InstanceId: instanceId,
    Name: name,
    Payload: null,
    Principal: null,
    DedupKey: null,
    State: 'pending',
    ConsumedByKey: null,
    ReceivedAt: T0,
    ...encode(over),
  });

export const instance = (id: string): Promise<WorkflowInstanceModel> => WorkflowInstanceModel.where('Id', id).first();
export const stepsOf = async (id: string): Promise<WorkflowStepModel[]> => await WorkflowStepModel.where('InstanceId', id).orderBy('Seq');
export const eventsOf = async (id: string): Promise<WorkflowEventModel[]> => await WorkflowEventModel.where('InstanceId', id).orderBy('Id');

/** The holder's lease ran out (it died or paused): any replica may claim the instance. */
export const expireLease = (id: string) => WorkflowInstanceModel.update({ ClaimedUntil: 0 }).where('Id', id);

/** Another replica claimed the instance: the holder's epoch is stale. */
export const takeOver = (id: string) =>
  WorkflowInstanceModel.update({ ClaimedBy: 'other', ClaimEpoch: 99, ClaimedUntil: T0 + 600_000 }).where('Id', id);

export function pick<T extends object, K extends keyof T>(o: T, ...keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) as Pick<T, K>;
}

export async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject');
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
}
