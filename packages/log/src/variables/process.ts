import { Injectable } from "@spinajs/di";
import { LogVariable } from "../types";

@Injectable(LogVariable)
export class ProcVariable extends LogVariable {
  protected ALLOWED_PROPS = ["title", "version", "pid", "platform"];
  public get Name(): string {
    return "proc";
  }
  public Value(option: string): string {
    if (this.ALLOWED_PROPS.indexOf(option) !== -1) {
      return (process as any)[option];
    }

    return `[${option} is undefined]`;
  }
}
