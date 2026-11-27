import 'mocha';
import { expect } from 'chai';
import { BaseController, BasePath, Get, Header, Ok } from '@spinajs/http';
import { ResponseCache } from '../src/index.js';
import { bootFailure, run, useServer } from './support/server.js';

const SHARED = { ttl: '1m', scope: 'shared', sharedBecause: 'the test reply is the same for every caller' } as const;

@BasePath('args')
class Args extends BaseController {
  @Get('region')
  @ResponseCache({ ...SHARED, vary: ['x-region'] })
  public region(@Header('x-region') region: string) {
    return new Ok({ run: run('region'), region });
  }
}

@BasePath('unnamed')
class UnnamedHeader extends BaseController {
  @Get('region')
  @ResponseCache({ ...SHARED, vary: ['xregion'] })
  public region(@Header() xregion: string) {
    return new Ok({ xregion });
  }
}

@BasePath('secret')
class UnkeyedHeader extends BaseController {
  @Get('value')
  @ResponseCache(SHARED)
  public value(@Header('x-secret') secret: string) {
    return new Ok({ secret });
  }
}

describe('@ResponseCache on a booted server', function () {
  this.timeout(60000);

  const { get } = useServer([Args]);

  it('shares a route whose @Header names a header in vary, keyed by that header', async () => {
    expect((await get('/args/region', { 'x-region': 'eu' })).body).to.deep.eq({ run: 1, region: 'eu' });
    expect((await get('/args/region', { 'x-region': 'us' })).body).to.deep.eq({ run: 2, region: 'us' });
    expect((await get('/args/region', { 'x-region': 'eu' })).body).to.deep.eq({ run: 1, region: 'eu' });
  });
});

describe('@ResponseCache refuses at boot a shared route', function () {
  this.timeout(120000);

  const refusal = async (controller: typeof BaseController): Promise<string> => String((await bootFailure([controller]))?.message);

  it('whose @Header() names no header: http names its argument only after the routes are registered', async () => {
    expect(await refusal(UnnamedHeader)).to.contain("GET /unnamed/region: @ResponseCache scope 'shared' would give one caller's reply to others, but the route reads the header of the argument #1, which @Header() does not name: cache it with scope 'principal', or write @Header('<name>') and name the header in vary");
  });

  it('whose @Header names a header not in vary', async () => {
    expect(await refusal(UnkeyedHeader)).to.contain("GET /secret/value: @ResponseCache scope 'shared' would give one caller's reply to others, but the route reads the header x-secret, which is not in the key");
  });
});
