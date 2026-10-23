import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsNative } from '@spinajs/fs';
import type { IFsLocalOptions } from '@spinajs/fs';

/**
 * fsNative without the calls the upload must never make (spec §6.3, §10). Every attempt is recorded, so a call that a
 * best-effort catch swallows still fails the suites that check Banned in afterEach.
 */
@Injectable('fs')
@PerInstanceCheck()
export class StrictFs extends fsNative<IFsLocalOptions> {
  public static readonly Banned: string[] = [];

  protected async doAppend(): Promise<void> {
    this.refuse('append');
  }

  protected async doRename(): Promise<void> {
    this.refuse('rename');
  }

  protected async doMove(): Promise<void> {
    this.refuse('move');
  }

  protected async doList(): Promise<string[]> {
    this.refuse('list');
  }

  private refuse(action: string): never {
    StrictFs.Banned.push(`${this.Name}:${action}`);
    throw new Error(`StrictFs ${this.Name}: ${action} is banned for @spinajs/upload`);
  }
}
