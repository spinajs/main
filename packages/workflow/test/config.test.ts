import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import packageConfig from '../src/config/workflow.js';
import { resolveWorkflowConfig, WORKFLOW_CONFIGURATION_SCHEMA, WORKFLOW_CONNECTION, WORKFLOW_DEFAULTS } from '../src/index.js';

describe('workflow configuration', () => {
  it('fills every key from WORKFLOW_DEFAULTS', () => {
    expect(resolveWorkflowConfig(undefined)).to.deep.equal(WORKFLOW_DEFAULTS);
    expect(WORKFLOW_DEFAULTS).to.deep.equal({
      enabled: true,
      tick: 1000,
      concurrency: 10,
      leaseTtl: 60_000,
      shutdownGrace: 30_000,
      maxStepResultBytes: 262_144,
      compensateOnCancel: false,
      retry: { attempts: 3, backoff: 'exponential', delay: '1s', maxDelay: '5m' },
    });
  });

  it('ships WORKFLOW_DEFAULTS as the package config', () => {
    expect(packageConfig.workflow).to.deep.equal(WORKFLOW_DEFAULTS);
  });

  it('merges a partial retry policy over the default one', () => {
    expect(resolveWorkflowConfig({ retry: { attempts: 5 } }).retry).to.deep.equal({ attempts: 5, backoff: 'exponential', delay: '1s', maxDelay: '5m' });
    expect(resolveWorkflowConfig({ concurrency: 2 }).concurrency).to.equal(2);
  });

  it('refuses an invalid workflow.retry', () => {
    expect(() => resolveWorkflowConfig({ retry: { attempts: 0 } })).to.throw(InvalidArgument, 'workflow.retry: retry.attempts must be an integer >= 1');
    expect(() => resolveWorkflowConfig({ retry: { attempts: 2, delay: 'soon' } })).to.throw(InvalidArgument);
  });

  it('the schema validates the workflow module on the workflow connection', () => {
    expect(WORKFLOW_CONNECTION).to.equal('workflow');
    expect(WORKFLOW_CONFIGURATION_SCHEMA.$configurationModule).to.equal('workflow');
    expect(WORKFLOW_CONFIGURATION_SCHEMA.properties.leaseTtl).to.deep.equal({ type: 'integer', minimum: 3000 });
    expect(WORKFLOW_CONFIGURATION_SCHEMA.properties.retry.required).to.deep.equal(['attempts']);
  });
});
