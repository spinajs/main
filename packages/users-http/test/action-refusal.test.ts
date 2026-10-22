import 'mocha';
import { expect } from 'chai';
import { Forbidden } from '@spinajs/exceptions';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';

import { asActionRefusal } from '../src/services/action-refusal.js';

const CODE = 'not-today';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.fail('expected a rejection'),
    (e: unknown) => e,
  );
}

describe('asActionRefusal (HOOK-4)', () => {
  it("answers a refusal of the route's own action as 403 action_refused with its code", async () => {
    const err = await rejection(
      asActionRefusal(['users.ban'], async () => {
        throw new ActionRefused('users.ban', CODE);
      }),
    );

    expect(err).to.be.instanceOf(Forbidden);
    expect(err).to.include({ error: 'action_refused', code: CODE });
  });

  it('answers a failed hook of its own action as 403 with code hook_error', async () => {
    const err = await rejection(
      asActionRefusal(['users.create'], async () => {
        throw new ActionHookFailed('users.create', 'BrokenHook', 'error');
      }),
    );

    expect(err).to.be.instanceOf(Forbidden);
    expect(err).to.include({ error: 'action_refused', code: 'hook_error' });
  });

  it('answers a refused admin password expire (authn.password.expire through users.expirePassword) as 403, not 500', async () => {
    const err = await rejection(
      asActionRefusal(['users.password.expire', 'authn.password.expire'], async () => {
        throw new ActionRefused('authn.password.expire', CODE);
      }),
    );

    expect(err).to.be.instanceOf(Forbidden);
    expect(err).to.include({ code: CODE });
  });

  it("rethrows a nested action's refusal as it is", async () => {
    const nested = new ActionRefused('users.update', CODE);
    expect(
      await rejection(
        asActionRefusal(['users.ban'], async () => {
          throw nested;
        }),
      ),
    ).to.eq(nested);
  });

  it('rethrows any other error and answers the result otherwise', async () => {
    const other = new Error('db down');
    expect(
      await rejection(
        asActionRefusal(['users.ban'], async () => {
          throw other;
        }),
      ),
    ).to.eq(other);
    expect(await asActionRefusal(['users.ban'], async () => 42)).to.eq(42);
  });
});
