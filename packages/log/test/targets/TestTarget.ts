/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */
import { format } from "@spinajs/configuration-common";
import { NewInstance, Injectable } from "@spinajs/di";
import { ICommonTargetOptions, ILogEntry } from "@spinajs/log-common";
import { LogTarget } from "./../../src/targets";

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@NewInstance()
@Injectable("TestTarget")
export class TestTarget extends LogTarget<ICommonTargetOptions> {
  public async write(data: ILogEntry): Promise<void> {
    this.sink(format(data.Variables, this.Options.layout));
  }

  public sink(_msg: string) {}
}
