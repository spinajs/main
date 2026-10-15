import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import { EpochMsConverter, ErrorGroupModel, jsonColumn, RunLogModel, RunModel, ScheduleModel } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

chai.use(chaiAsPromised);

const T = Date.parse('2026-01-05T10:00:00Z');

describe('scheduler models', () => {
  beforeEach(async () => {
    await bootTestEnv();
  });

  it('round-trips a schedule row with epoch ms, json and booleans', async () => {
    await ScheduleModel.create({
      Name: 'a',
      Definition: { spec: { kind: 'every' } },
      DefinitionHash: 'h',
      NextRunAt: T,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: false,
      UpdatedAt: T,
    });
    const row = await ScheduleModel.where('Name', 'a').first();
    expect(row.NextRunAt).to.eq(T);
    expect(row.Definition).to.deep.eq({ spec: { kind: 'every' } });
    expect(row.Paused).to.eq(false);
    expect(row.LeaseOwner).to.eq(null);
  });

  it('reads int8 strings (Postgres) back as epoch-ms numbers', () => {
    const column = ScheduleModel.getModelDescriptor().Columns.find((c) => c.Name === 'NextRunAt');
    expect(column?.Converter).to.be.instanceOf(EpochMsConverter);
    const converter = column!.Converter as EpochMsConverter;
    expect(converter.fromDB(String(T))).to.eq(T);
    expect(converter.fromDB(null)).to.eq(null);
  });

  it('round-trips a run row and supports a conditional static update', async () => {
    await RunModel.create({
      Id: 'r1',
      Schedule: 'a',
      Trigger: 'manual',
      TriggeredBy: { kind: 'user', id: '7' },
      Params: { file: 'x.csv' },
      Status: 'queued',
      Attempt: 1,
      MaxAttempts: 1,
      CreatedAt: T,
      Progress: 0,
      CancelRequested: false,
      Forced: false,
    });
    const lost = await RunModel.update({ Status: 'running' }).where('Id', 'r1').where('Status', 'running');
    expect(lost.RowsAffected).to.eq(0);
    const won = await RunModel.update({ Status: 'running', Result: jsonColumn({ ok: true }), LeaseUntil: T + 60_000 })
      .where('Id', 'r1')
      .where('Status', 'queued');
    expect(won.RowsAffected).to.eq(1);
    const row = await RunModel.where('Id', 'r1').first();
    expect(row.Params).to.deep.eq({ file: 'x.csv' });
    expect(row.TriggeredBy).to.deep.eq({ kind: 'user', id: '7' });
    expect(row.Result).to.deep.eq({ ok: true });
    expect(row.LeaseUntil).to.eq(T + 60_000);
  });

  it('assigns journal ids and enforces unique (RunId, Seq) and unique Pos', async () => {
    const a = await RunLogModel.create({
      RunId: 'r1',
      Schedule: 'a',
      Seq: 1,
      Attempt: 1,
      Ts: T,
      Kind: 'status',
      Data: { type: 'status' } as never,
      Pos: 1,
    });
    const b = await RunLogModel.create({
      RunId: 'r1',
      Schedule: 'a',
      Seq: 2,
      Attempt: 1,
      Ts: T,
      Kind: 'log',
      Data: { type: 'log' } as never,
      Pos: 2,
    });
    expect(b.Id).to.be.greaterThan(a.Id);
    await expect(
      RunLogModel.create({
        RunId: 'r1',
        Schedule: 'a',
        Seq: 2,
        Attempt: 1,
        Ts: T,
        Kind: 'log',
        Data: {} as never,
        Pos: 3,
      }),
    ).to.be.rejected;
    await expect(
      RunLogModel.create({
        RunId: 'r1',
        Schedule: 'a',
        Seq: 3,
        Attempt: 1,
        Ts: T,
        Kind: 'log',
        Data: {} as never,
        Pos: 2,
      }),
    ).to.be.rejected;
  });

  it('seeds the journal position counter', async () => {
    const orm = await DI.resolve(Orm);
    const rows = (await (
      orm.Connections.get('default') as unknown as {
        executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<unknown>;
      }
    ).executeOnDb('SELECT "Id", "LastPos" FROM "__scheduler_journal_pos"', [], QueryContext.Select)) as Array<{
      Id: number;
      LastPos: number;
    }>;
    expect(rows.map((r) => [Number(r.Id), Number(r.LastPos)])).to.deep.eq([[1, 0]]);
  });

  it('enforces unique (Schedule, Fingerprint)', async () => {
    const row = {
      Schedule: 'a',
      Fingerprint: 'f',
      Name: 'Error',
      SampleMessage: 'm',
      Count: 1,
      FirstSeen: T,
      LastSeen: T,
      Status: 'open' as const,
    };
    await ErrorGroupModel.create(row);
    await expect(ErrorGroupModel.create(row)).to.be.rejected;
  });
});
