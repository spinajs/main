import { IBlackHoleTargetOptions } from "./../types";
import { Injectable, Singleton } from "@spinajs/di";
import { LogTarget } from "./LogTarget";

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@Singleton()
@Injectable("BlackHoleTarget")
export class BlackHoleTarget extends LogTarget<IBlackHoleTargetOptions> {
  public async write(): Promise<void> {
    return;
  }
}
