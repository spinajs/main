/* eslint-disable @typescript-eslint/no-empty-function */
import { format } from "@spinajs/configuration-common";
import { NewInstance, Injectable } from "@spinajs/di";
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";
 

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@NewInstance()
@Injectable("TestWildcard")
export class TestWildcard extends LogTarget<ICommonTargetOptions> {
  public async write(data: ILogEntry): Promise<void> {
    this.sink(format(data.Variables, this.Options.layout));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public sink(_msg: string) {}
}
