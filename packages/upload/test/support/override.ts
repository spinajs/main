import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import sinon from 'sinon';

/** Answers `path` with `value` until sinon.restore(); every other path reads the real configuration. */
export async function overrideConfig(path: string, value: unknown): Promise<void> {
  const configuration = await DI.resolve(Configuration);
  const get = configuration.get.bind(configuration) as (p: string | string[], d?: unknown) => unknown;
  sinon.stub(configuration, 'get').callsFake((p: string | string[], d?: unknown) => (p === path ? value : get(p, d)));
}
