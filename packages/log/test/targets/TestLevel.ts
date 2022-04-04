/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */
import { ICommonTargetOptions, ILogEntry, LogTarget } from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { format } from "@spinajs/configuration-common";

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@Singleton()
@Injectable("TestLevel")
export class TestLevel extends LogTarget<ICommonTargetOptions> {
  public async write(data: ILogEntry): Promise<void> {
    this.sink(format(data.Variables, this.Options.layout));
  }

  public sink(_msg: string) {}
}
