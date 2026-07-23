import { Singleton, Injectable } from '@spinajs/di';
import { PerfSink, IPerfMetric } from '@spinajs/log';

@Singleton()
@Injectable(PerfSink)
export class InMemoryPerfSink extends PerfSink {
  public collect(_metric: IPerfMetric): void {
    // implemented in the InMemoryPerfSink task
  }
}
