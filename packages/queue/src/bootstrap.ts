/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { Queue_2022_10_18_01_13_00 } from './migrations/Queue_2022_10_18_01_13_00';
import { JobModel } from './models/JobModel';

@Injectable(Bootstrapper)
export class QueueBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(JobModel).asValue('__models__');
    DI.register(Queue_2022_10_18_01_13_00).asValue('__migrations__');
    return;
  }
}
