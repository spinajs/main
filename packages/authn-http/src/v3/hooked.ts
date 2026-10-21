import type { ActionName, Hooks, InputOf, OutputOf, RunOptions } from '@spinajs/hooks';

/** Hooks.run, or `impl` alone for a controller built with `new` that nothing injected Hooks into. */
export function runHooked<A extends ActionName>(hooks: Hooks | undefined, action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<OutputOf<A>>, opts: RunOptions<A>): Promise<OutputOf<A>> {
  return hooks ? hooks.run(action, input, impl, opts) : impl(input);
}
