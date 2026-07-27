/* eslint-disable @typescript-eslint/no-explicit-any */
import "mocha";
import { expect } from "chai";
import { DI } from "@spinajs/di";
import { Perf, PerfSink, IPerfMetric } from "@spinajs/log-common";
import { SqlDriver } from "../src/index.js";
import { QueryContext, ITransactionContext, ITransactionOptions } from "@spinajs/orm";

class RecordingSink extends PerfSink {
  public metrics: IPerfMetric[] = [];
  public collect(m: IPerfMetric): void {
    this.metrics.push(m);
  }
}

// Minimal concrete driver: executeOnDb just echoes, so we test the execute() wrapper.
class FakeDriver extends SqlDriver {
  public lastStmt = "";
  public executeOnDb(stmt: string, _params: unknown[], _ctx: QueryContext): Promise<unknown> {
    this.lastStmt = stmt;
    return Promise.resolve([{ ok: 1 }]);
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public connect(): Promise<any> {
    return Promise.resolve(this);
  }
  public disconnect(): Promise<any> {
    return Promise.resolve(this);
  }
  public supportedFeatures(): any {
    return {};
  }
  public tableInfo(): Promise<any[]> {
    return Promise.resolve([]);
  }
  public transaction(): Promise<any> {
    return Promise.resolve();
  }

  // OrmDriver.transaction() is a concrete template method over these seven primitives.
  // This double overrides transaction() itself and never talks to a database, so they only
  // need to exist. See packages/orm-sql/test/fixture.ts for the same treatment.
  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    return { depth: 0 };
  }
  protected async _commit(_ctx: ITransactionContext): Promise<void> {}
  protected async _rollback(_ctx: ITransactionContext): Promise<void> {}
  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
  protected async _dispose(_ctx: ITransactionContext): Promise<void> {}
}

// Minimal builder stub: toDB() returns one compiled statement.
function fakeBuilder(expression: string): any {
  return {
    QueryContext: QueryContext.Select,
    Model: { name: "Thing" },
    toDB: () => ({ expression, bindings: [1, 2] }),
  };
}

describe("SqlDriver.execute perf instrumentation", () => {
  let sink: RecordingSink;

  beforeEach(() => {
    DI.clearCache();
    DI.register(RecordingSink).as(PerfSink);

    // Pick OUR sink out of the set rather than trusting index 0. `@spinajs/telemetry`
    // self-registers InMemoryPerfSink and PromMetricSink via `@Injectable(PerfSink)`, so as
    // soon as anything in the run pulls that package in, index 0 is one of those and this
    // read handed back a sink with no `metrics` array.
    const found = (DI.resolve(Array.ofType(PerfSink)) as PerfSink[]).find((s): s is RecordingSink => s instanceof RecordingSink);
    if (!found) {
      throw new Error('RecordingSink was registered but not resolved through Array.ofType(PerfSink)');
    }
    sink = found;

    Perf.refreshSinks();
  });

  afterEach(() => DI.clearCache());

  it("emits one orm.query span per executed statement with sql in fields", async () => {
    const driver = new FakeDriver({} as any);
    await driver.execute(fakeBuilder("SELECT * FROM thing"));

    const spans = sink.metrics.filter((m) => m.name === "orm.query");
    expect(spans).to.have.length(1);
    expect(spans[0].kind).to.eq("span");
    expect(spans[0].fields?.sql).to.eq("SELECT * FROM thing");
    expect(spans[0].labels?.context).to.eq(String(QueryContext.Select));
  });

  it("emits an error span when the query fails", async () => {
    class FailingDriver extends SqlDriver {
      public executeOnDb(): Promise<unknown> {
        return Promise.reject(new Error("db down"));
      }
      public ping(): Promise<boolean> {
        return Promise.resolve(true);
      }
      public connect(): Promise<any> {
        return Promise.resolve(this);
      }
      public disconnect(): Promise<any> {
        return Promise.resolve(this);
      }
      public supportedFeatures(): any {
        return {};
      }
      public tableInfo(): Promise<any[]> {
        return Promise.resolve([]);
      }
      public transaction(): Promise<any> {
        return Promise.resolve();
      }

      // see FakeDriver above — required by OrmDriver's transaction contract, unused here
      protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
        return { depth: 0 };
      }
      protected async _commit(_ctx: ITransactionContext): Promise<void> {}
      protected async _rollback(_ctx: ITransactionContext): Promise<void> {}
      protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
      protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
      protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {}
      protected async _dispose(_ctx: ITransactionContext): Promise<void> {}
    }
    const driver = new FailingDriver({} as any);
    let threw = false;
    try {
      await driver.execute(fakeBuilder("SELECT 1"));
    } catch {
      threw = true;
    }
    expect(threw).to.eq(true);
    const spans = sink.metrics.filter((m) => m.name === "orm.query");
    expect(spans).to.have.length(1);
    expect(spans[0].error).to.be.instanceOf(Error);
  });
});
