import * as chai from 'chai';
import 'mocha';

import { ActionRefused } from '../src/index.js';
import { RecordingActionHook, mutatingHook, refusingHook } from '../src/testing/index.js';
import { addHook, boot, disposeChildren, rejectionOf, useTestLog } from './support.js';

const expect = chai.expect;

interface Member {
  name: string;
  role: string;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'kit.save': { input: Member; output: { id: string } };
    'misc.ping': { input: Member; output: { id: string } };
  }
}

const member = (): Member => ({ name: 'ann', role: 'user' });
const saved = async () => ({ id: 'k-1' });
const fields = (r: RecordingActionHook) => r.calls.map((c) => [c.phase, c.action, c.input, c.output, c.error]);

describe('@spinajs/hooks/testing', function () {
  this.timeout(10000);
  useTestLog();

  afterEach(disposeChildren);

  describe('RecordingActionHook', () => {
    it('records before and after once each, in order, with the action, the input and the output', async () => {
      const recorder = new RecordingActionHook();
      const { hooks } = await boot({}, (c) => addHook(c, recorder));
      const output = { id: 'k-1' };

      await hooks.run('kit.save', member(), async () => output, { mutable: [] });

      expect(fields(recorder)).to.deep.eq([
        ['before', 'kit.save', member(), undefined, undefined],
        ['after', 'kit.save', member(), output, undefined],
      ]);
      expect(recorder.calls[1].output).to.equal(output);
    });

    it('records before and failed once each, in order, with the error', async () => {
      const recorder = new RecordingActionHook();
      const { hooks } = await boot({}, (c) => addHook(c, recorder));
      const failure = new Error('save failed');

      await rejectionOf(
        hooks.run(
          'kit.save',
          member(),
          async () => {
            throw failure;
          },
          { mutable: [] },
        ),
      );

      expect(fields(recorder)).to.deep.eq([
        ['before', 'kit.save', member(), undefined, undefined],
        ['failed', 'kit.save', member(), undefined, failure],
      ]);
      expect(recorder.calls[1].error).to.equal(failure);
    });

    it('matches every action by default and only its patterns when given', async () => {
      const every = new RecordingActionHook();
      const misc = new RecordingActionHook(['misc.*']);
      const { hooks } = await boot({}, (c) => {
        addHook(c, every);
        addHook(c, misc);
      });

      await hooks.run('kit.save', member(), saved, { mutable: [] });
      await hooks.run('misc.ping', member(), saved, { mutable: [] });

      expect(every.calls.map((c) => `${c.phase} ${c.action}`)).to.deep.eq(['before kit.save', 'after kit.save', 'before misc.ping', 'after misc.ping']);
      expect(misc.calls.map((c) => `${c.phase} ${c.action}`)).to.deep.eq(['before misc.ping', 'after misc.ping']);
    });
  });

  describe('refusingHook', () => {
    it('refuses a matching action with its code, and lets any other action run', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, refusingHook('kit.*', 'kit_closed')));
      let ran = 0;
      const impl = async () => {
        ran++;
        return { id: 'k-1' };
      };

      const e = await rejectionOf(hooks.run('kit.save', member(), impl, { mutable: [] }));
      expect(e).to.be.instanceOf(ActionRefused);
      expect((e as ActionRefused).code).to.eq('kit_closed');
      expect((e as ActionRefused).action).to.eq('kit.save');
      expect(ran).to.eq(0);

      expect(await hooks.run('misc.ping', member(), impl, { mutable: [] })).to.deep.eq({ id: 'k-1' });
      expect(ran).to.eq(1);
    });

    it('runs at the order it is given', async () => {
      for (const [order, recorded] of [
        [-1, 0],
        [1, 1],
      ] as const) {
        const recorder = new RecordingActionHook();
        const { hooks } = await boot({}, (c) => {
          addHook(c, recorder);
          addHook(c, refusingHook('*', 'closed', { order }));
        });

        await rejectionOf(hooks.run('kit.save', member(), saved, { mutable: [] }));

        expect(recorder.calls.filter((c) => c.phase === 'before'), `order ${order}`).to.have.length(recorded);
      }
    });
  });

  describe('mutatingHook', () => {
    it('changes only the keys the action declares mutable', async () => {
      const received: Member[] = [];
      const { hooks } = await boot({}, (c) => addHook(c, mutatingHook('kit.save', { name: 'bob', role: 'admin' })));

      await hooks.run(
        'kit.save',
        member(),
        async (i) => {
          received.push(i);
          return { id: 'k-1' };
        },
        { mutable: ['name'] },
      );

      expect(received).to.deep.eq([{ name: 'bob', role: 'user' }]);
    });

    it('leaves an action it does not match unchanged', async () => {
      const received: Member[] = [];
      const { hooks } = await boot({}, (c) => addHook(c, mutatingHook('kit.save', { name: 'bob' })));

      await hooks.run(
        'misc.ping',
        member(),
        async (i) => {
          received.push(i);
          return { id: 'k-1' };
        },
        { mutable: ['name'] },
      );

      expect(received).to.deep.eq([member()]);
    });
  });
});
