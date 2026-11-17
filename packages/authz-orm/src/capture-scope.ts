import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { CaptureReadScope } from '@spinajs/orm';

/** The capture's key select must see every row a write reaches, whoever runs the write. */
@Injectable(CaptureReadScope)
export class SystemCaptureReadScope extends CaptureReadScope {
  run<T>(fn: () => Promise<T>): Promise<T> {
    return runWithPrincipal(SYSTEM, fn);
  }
}
