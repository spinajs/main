import 'mocha';
import { expect } from 'chai';
import type { WorkflowEntry } from '@spinajs/manifest';
import { workflowDuplicateVersion } from '../../src/doctor/rules/workflow-duplicate-version.js';
import { workflowSignalWithoutAuthorizer } from '../../src/doctor/rules/workflow-signal-without-authorizer.js';
import { workflowTooManyVersions } from '../../src/doctor/rules/workflow-too-many-versions.js';
import { fixture, service, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const wf = (name: string, version: number, className: string, extra: Partial<WorkflowEntry> = {}): WorkflowEntry => ({ name, version, className, signals: [], source: src(`src/${className}.ts`), ...extra });

describe('WF001 workflow-duplicate-version', () => {
  it('reports the second class that declares a name and version', () => {
    const m = fixture({ workflows: [wf('order', 2, 'OrderV2'), wf('order', 2, 'OrderTwo'), wf('order', 1, 'OrderV1')] });
    expect(workflowDuplicateVersion.run(m, ctx)).to.deep.equal([
      { code: 'WF001', severity: 'error', message: 'Workflow order version 2 is declared by OrderV2 and OrderTwo', source: src('src/OrderTwo.ts') },
    ]);
    expect(workflowDuplicateVersion.run(fixture(), ctx)).to.deep.equal([]);
  });
});

describe('WF002 workflow-signal-without-authorizer', () => {
  const approval = wf('order', 2, 'OrderV2', { signals: [{ name: 'approved', permission: 'orders:approve' }, { name: 'note' }] });

  it('warns about a permissioned signal when only DenyAllSignalAuthorizer is registered', () => {
    const m = fixture({ workflows: [approval], services: [service({ className: 'DenyAllSignalAuthorizer', registeredAs: ['SignalAuthorizer', 'DenyAllSignalAuthorizer'] })] });
    expect(workflowSignalWithoutAuthorizer.run(m, ctx)).to.deep.equal([
      {
        code: 'WF002',
        severity: 'warning',
        message: 'Workflow order v2 waits for signal approved with permission orders:approve, but no SignalAuthorizer other than DenyAllSignalAuthorizer is registered; every such signal is rejected',
        source: src('src/OrderV2.ts'),
      },
    ]);
  });

  it('is silent once another SignalAuthorizer is registered', () => {
    const m = fixture({ workflows: [approval], services: [service({ className: 'AuthzSignalAuthorizer', registeredAs: ['SignalAuthorizer', 'AuthzSignalAuthorizer'] })] });
    expect(workflowSignalWithoutAuthorizer.run(m, ctx)).to.deep.equal([]);
  });
});

describe('WF003 workflow-too-many-versions', () => {
  it('reports a workflow with more than three registered versions at its newest class', () => {
    const m = fixture({ workflows: [1, 2, 3, 4].map((v) => wf('order', v, `OrderV${v}`)).concat([wf('billing', 1, 'BillingV1')]) });
    expect(workflowTooManyVersions.run(m, ctx)).to.deep.equal([
      { code: 'WF003', severity: 'info', message: 'Workflow order has 4 registered versions (1, 2, 3, 4); remove the versions no instance uses', source: src('src/OrderV4.ts') },
    ]);
  });
});
