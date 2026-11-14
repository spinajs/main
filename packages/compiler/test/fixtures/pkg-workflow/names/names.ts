import { Workflow, type Ctx } from '../src/api.js';

@Workflow('names')
export class Names {
  public async run(ctx: Ctx): Promise<void> {
    await ctx.waitForEvent('a#b');
    await ctx.waitForEvent('all*');
    await ctx.waitForEvent('ok');
  }
}
