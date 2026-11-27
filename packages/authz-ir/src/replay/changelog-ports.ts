import type { ChangeLog } from '@spinajs/authz';

import { coverageGap, sameImage, stateAt } from './history.js';
import { ReplayHistory } from './history-scan.js';
import type { KeyStateFunctions, ReplayHistoryPorts } from './ports.js';

/** The key-state rules of the authz changelog. */
export const changeLogKeyState: KeyStateFunctions = { stateAt, coverageGap, sameImage };

/** The replay ports over the authz changelog: the scan of `ReplayHistory` and the rules above. */
export function changeLogReplay(log: ChangeLog): ReplayHistoryPorts {
  return { history: (at, kinds, limits, signal) => ReplayHistory.load(log, at, kinds, limits, signal), keyState: changeLogKeyState };
}
