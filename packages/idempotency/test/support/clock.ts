import type { IContainer } from '@spinajs/di';
import { Clock, DbTimeSource } from '@spinajs/durable';
import type { FakeClock } from '@spinajs/durable/testing';

// replace: DbClock is a @Singleton(); the test clock must not merely be registered after W1's defaults
export const withClock =
  (clock: FakeClock) =>
  (container: IContainer): void => {
    container.register(() => clock).as(Clock, { replace: true });
    container.register(() => clock.dbSource).as(DbTimeSource, { replace: true });
  };
