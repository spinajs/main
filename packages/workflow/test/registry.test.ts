import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { defineWorkflow, DuplicateWorkflowDefinition, undefineWorkflow, Workflow, WorkflowDefinition, WorkflowNotRegistered, WorkflowRegistry } from '../src/index.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { rejects } from './support/rows.js';

@Workflow('reg-order')
class RegOrderV1 extends WorkflowDefinition {
  public run(): Promise<string> {
    return Promise.resolve('v1');
  }
}

@Workflow('reg-order', { version: 3, timeout: '2h' })
class RegOrderV3 extends WorkflowDefinition {
  public run(): Promise<string> {
    return Promise.resolve('v3');
  }
}

class Clash extends WorkflowDefinition {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

async function registry(): Promise<WorkflowRegistry> {
  await bootTestEnv();
  return DI.resolve(WorkflowRegistry);
}

describe('WorkflowRegistry', () => {
  afterEach(disposeTestEnv);

  it('registers @Workflow classes by name and version', async () => {
    const r = await registry();
    expect(r.find('reg-order', 1)?.target).to.equal(RegOrderV1);
    const v3 = r.find('reg-order', 3)!;
    expect([v3.name, v3.version, v3.target, v3.timeoutMs]).to.deep.equal(['reg-order', 3, RegOrderV3, 7_200_000]);
    expect(r.find('reg-order', 2)).to.equal(undefined);
    expect(r.all().filter((w) => w.name === 'reg-order').map((w) => w.version)).to.have.members([1, 3]);
  });

  it('starts new instances on the highest version unless one is named', async () => {
    const r = await registry();
    expect(r.latest('reg-order')?.version).to.equal(3);
    expect(r.resolveForStart('reg-order').version).to.equal(3);
    expect(r.resolveForStart('reg-order', 1).target).to.equal(RegOrderV1);
    expect(r.resolveForStart(RegOrderV1).version).to.equal(1);
    expect(() => r.resolveForStart('reg-order', 2)).to.throw(WorkflowNotRegistered, "workflow 'reg-order' version 2 is not registered");
    expect(() => r.resolveForStart('reg-missing')).to.throw(WorkflowNotRegistered, "workflow 'reg-missing' is not registered");
    expect(() => r.resolveForStart(Clash)).to.throw(WorkflowNotRegistered, "workflow 'Clash' is not registered");
  });

  it('refuses two classes with the same name and version', async () => {
    class ClashTwo extends WorkflowDefinition {
      public run(): Promise<void> {
        return Promise.resolve();
      }
    }
    defineWorkflow(Clash, 'reg-clash');
    defineWorkflow(ClashTwo, 'reg-clash', { version: 1 });
    try {
      const err = await rejects(registry());
      expect(err).to.be.instanceOf(DuplicateWorkflowDefinition);
      expect(err.message).to.equal("workflow 'reg-clash' version 1 is declared by Clash and ClashTwo");
    } finally {
      undefineWorkflow('reg-clash');
    }
  });

  it('refuses names with edge whitespace, control characters or unpaired surrogates', async () => {
    for (const name of ['', ' reg', 'reg ', 'reg\n', 'r\u0000g', 'r\u007Fg', 'r\uD800g', 'x'.repeat(129)]) {
      defineWorkflow(Clash, name);
      try {
        const err = await rejects(registry());
        expect(err, JSON.stringify(name)).to.be.instanceOf(InvalidArgument);
        expect(err.message, JSON.stringify(name)).to.match(/^workflow name must /);
      } finally {
        undefineWorkflow(name);
      }
    }
  });

  it('refuses a version that is not a positive integer', async () => {
    defineWorkflow(Clash, 'reg-bad', { version: 0 });
    try {
      const err = await rejects(registry());
      expect(err).to.be.instanceOf(InvalidArgument);
      expect(err.message).to.equal("workflow 'reg-bad': version must be an integer >= 1, got 0");
    } finally {
      undefineWorkflow('reg-bad');
    }
  });
});
