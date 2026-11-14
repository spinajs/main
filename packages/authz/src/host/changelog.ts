import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ChangeLog, NoChangeLog } from '../contracts/changelog.js';

const NONE = new NoChangeLog();

/** The `ChangeLog` registered in `container` (or above it); a `NoChangeLog` when there is none. */
export function changeLog(container: IContainer = DI.RootContainer): ChangeLog {
  return container.hasRegistered(ChangeLog) ? container.resolve(ChangeLog) : NONE;
}
