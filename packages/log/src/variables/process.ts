import { Injectable } from "@spinajs/di";
import { LogVariable } from "../types";

@Injectable(LogVariable)
export class ProcVariable extends LogVariable {
  public get Name(): string {
    return "proc";
  }
  public Value(option: "title" | "version" | "pid" | "platform"): string {
    return process[`${option}`] as string;
  }
}
