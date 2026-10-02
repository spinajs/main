import 'mocha';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import socketConfig from '../src/config/http-socket.js';

chai.use(chaiAsPromised);

let overrides: Record<string, unknown> = {};

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return _.merge(
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        configuration: { isProduction: false },
        http: { socket: _.cloneDeep(socketConfig.http.socket) },
      },
      overrides,
    );
  }
}

/** Fresh DI cache and configuration; `cfg` is merged over the test defaults. */
export async function configure(cfg: Record<string, unknown> = {}): Promise<void> {
  overrides = cfg;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  await DI.resolve(Configuration);
}
