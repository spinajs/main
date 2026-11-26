import { expect } from 'chai';
import 'mocha';

import * as api from '../src/index.js';

describe('the package index', () => {
  it('exports the public surface and nothing else', () => {
    expect(Object.keys(api).sort()).to.deep.eq(['ArtifactSource', 'DomainReplayService', 'REPLAY_DEFAULTS', 'REPLAY_MAX_CHANGES_LIMIT', 'RecordingSource', 'RecordingUnreadable', 'ReplayBudgetExceeded', 'ReplayBusy', 'ReplayHistory', 'ReplayService', 'Replayer', 'StateSource', 'coverageGap', 'replayLimits', 'replayWindow', 'sameImage', 'stateAt', 'verdictOf']);
  });
});
