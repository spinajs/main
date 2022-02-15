/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';

import * as chai from 'chai';
import { expect } from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { format } from '@spinajs/configuration-common';
import { DateTime } from 'luxon';

// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
chai.use(chaiAsPromised);

describe('Variable forma test', () => {
  beforeEach(() => {
    DI.clearCache();
  });

  it('Should format with basic variables', () => {
    const formatted = format(
      {
        message: 'hello world',
      },
      '${date} ${message:world}',
    );

    expect(formatted).to.eq(`${DateTime.now().toFormat('dd/MM/yyyy')} hello world`);
  });
});
