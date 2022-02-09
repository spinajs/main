import { Injectable } from "@spinajs/di";
import { DateTime } from "luxon";
import { LogVariable } from "@spinajs/log-common";

@Injectable(LogVariable)
export class DateTimeLogVariable extends LogVariable {
  public get Name(): string {
    return "datetime";
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? "dd/MM/yyyy HH:mm:ss.SSS ZZ");
  }
}

@Injectable(LogVariable)
export class DateLogVariable extends LogVariable {
  constructor(protected format?: string) {
    super();
  }

  public get Name(): string {
    return "date";
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? "dd/MM/yyyy");
  }
}

@Injectable(LogVariable)
export class TimeLogVariable extends LogVariable {
  constructor(protected format?: string) {
    super();
  }

  public get Name(): string {
    return "time";
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? "HH:mm:ss.SSS");
  }
}
