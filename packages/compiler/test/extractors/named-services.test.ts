import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractConfigUsages, extractServices } from '../../src/index.js';

describe('named-service injections', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('named-services.ts'))!;

  it('are property injections of the type the decorator names', () => {
    const [notifier] = extractServices(ctx, file);
    expect(notifier.propertyInjects).to.deep.equal([
      { property: 'Channel', token: 'Channel', optional: false, array: false },
      { property: 'Fallback', token: 'Channel', optional: true, array: false },
      { property: 'Steps', token: 'Step', optional: false, array: true },
      { property: 'Audit', token: 'AuditStep', optional: false, array: true },
    ]);
  });

  it('read their configuration path', () => {
    expect(extractConfigUsages(ctx, file).map((u) => u.path)).to.deep.equal(['notify.channel', 'notify.fallback', 'notify.steps', 'notify.audit']);
  });
});
