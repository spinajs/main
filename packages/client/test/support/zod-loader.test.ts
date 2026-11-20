import 'mocha';
import { expect } from 'chai';
import { createZodLoader } from './zod.js';

describe('the zod test loader', () => {
  it('keeps two loaders from deleting or overwriting each other', async () => {
    const [first, second] = [createZodLoader(), createZodLoader()];
    const one = await first.loadZod("export const answer = 1;");
    const two = await second.loadZod("export const answer = 2;");
    expect([one.answer, two.answer]).to.deep.equal([1, 2]);
    first.clearLoaded();
    // The first one has gone: the second still loads, and what it loaded before is intact.
    expect((await second.loadZod("export const answer = 3;")).answer).to.equal(3);
    expect(two.answer).to.equal(2);
    second.clearLoaded();
    expect((await first.loadZod("export const answer = 4;")).answer).to.equal(4);
    first.clearLoaded();
  });
});
