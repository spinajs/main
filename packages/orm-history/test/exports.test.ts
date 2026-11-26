import { expect } from 'chai';
import 'mocha';

import * as api from '../src/index.js';

describe('the package index', () => {
  it('exports the public surface and nothing else', () => {
    expect(Object.keys(api).sort()).to.deep.eq(['History', 'HistoryConfigError', 'HistoryWriteError', 'OrmHistoryCoverage_2026_11_25_00_00_00', 'OrmHistory_2026_11_16_00_00_00', 'historyOf', 'registerHistory', 'toHistoryEntry']);
  });
});
