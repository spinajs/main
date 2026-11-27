import { expect } from 'chai';
import 'mocha';

import * as api from '../src/index.js';

describe('the package index', () => {
  it('exports the public surface and nothing else', () => {
    expect(Object.keys(api).sort()).to.deep.eq(['ArtifactSource', 'RecordingSource', 'ReplayService', 'Replayer', 'StateSource', 'coverageGap', 'sameImage', 'stateAt']);
  });
});
