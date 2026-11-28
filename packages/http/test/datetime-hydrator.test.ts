import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import type { Class } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Body, Controllers, DateTimeHydrator, Get, Header, HttpServer, Ok, Param, ParameterType, Post, Query } from '../src/index.js';
import type { IRouteParameter } from '../src/index.js';

const AT: IRouteParameter = { Index: 0, Type: ParameterType.FromQuery, RuntimeType: DateTime, Name: 'at' };
const NOT_A_DATE = "Argument 'at' is not a valid date";

async function refusal(input: unknown): Promise<unknown> {
  try {
    await new DateTimeHydrator().hydrate(input, AT);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('DateTimeHydrator', () => {
  describe('a present value that is not a date', () => {
    const cases: [string, unknown][] = [
      ['garbage text', 'garbage'],
      ['an ISO-looking text that does not parse', '2026-13-45T25:61:00Z'],
      ['an SQL date, which is not ISO 8601', '2026-01-01 10:00:00'],
      ['an HTTP date without the Date: prefix', 'Wed, 21 Oct 2015 07:28:00 GMT'],
      ['a Date: header form that does not parse', 'Date: garbage'],
      ['seconds out of range as text', '1e20'],
      ['seconds out of range as a JSON number', 1e20],
      ['Infinity as text', 'Infinity'],
      ['-Infinity as a number', -Infinity],
      ['NaN as text', 'NaN'],
      ['NaN as a number', NaN],
      ['a repeated query parameter', ['2022-06-28T20:59:55Z', 'x']],
      ['an object', { a: 1 }],
    ];

    for (const [name, input] of cases) {
      it(`refuses ${name} with BadRequest naming the argument`, async () => {
        const err = await refusal(input);

        expect(err).to.be.instanceOf(BadRequest).and.to.have.property('message', NOT_A_DATE);
      });
    }
  });

  describe('a valid value', () => {
    it('reads ISO 8601 as the same instant in the local zone', async () => {
      const at = await new DateTimeHydrator().hydrate('2022-06-28T22:59:55+02:00', AT);

      expect(at.toMillis()).to.eq(Date.UTC(2022, 5, 28, 20, 59, 55));
      expect(at.zoneName).to.eq(DateTime.local().zoneName);
    });

    it('reads a number, as text or JSON, as Unix seconds in the local zone', async () => {
      for (const input of ['1656367511', 1656367511]) {
        const at = await new DateTimeHydrator().hydrate(input, AT);

        expect(at.toMillis()).to.eq(1656367511000);
        expect(at.zoneName).to.eq(DateTime.local().zoneName);
      }
    });

    it('reads the Date: header form as an HTTP date', async () => {
      const at = await new DateTimeHydrator().hydrate('Date: Wed, 21 Oct 2015 07:28:00 GMT', AT);

      expect(at.toMillis()).to.eq(Date.UTC(2015, 9, 21, 7, 28, 0));
    });
  });

  describe('an absent value', () => {
    it('hands an absent argument on as before, without a refusal', async () => {
      const at = await new DateTimeHydrator().hydrate(undefined, AT);

      expect(at.isValid).to.eq(false);
      expect(at.invalidReason).to.eq('no iso or unix timestamp');
    });

    it('reads null and an empty text as the epoch, as before', async () => {
      for (const input of [null, '']) {
        const at = await new DateTimeHydrator().hydrate(input, AT);

        expect(at.toMillis()).to.eq(0);
      }
    });
  });
});

@BasePath('datetime-hydrator')
class DateTimeArgsController extends BaseController {
  @Get('query')
  public query(@Query() at: DateTime) {
    return new Ok({ valid: at.isValid, millis: at.isValid ? at.toMillis() : null });
  }

  @Get('param/:at')
  public param(@Param() at: DateTime) {
    return new Ok({ millis: at.toMillis() });
  }

  @Get('header')
  public header(@Header('x-at') at: DateTime) {
    return new Ok({ millis: at.toMillis() });
  }

  @Post('body')
  public body(@Body() at: DateTime, @Body() note: string) {
    return new Ok({ millis: at.toMillis(), note });
  }
}

class DateTimeArgsConfiguration extends TestConfiguration {}

const CONTROLLERS: Class<BaseController>[] = [DateTimeArgsController];

describe('DateTimeHydrator through a route', function () {
  this.timeout(30000);

  let app: TestApp;
  let server: HttpServer;

  before(async () => {
    app = await httpApp({
      configuration: DateTimeArgsConfiguration,
      register: (c) => {
        for (const type of CONTROLLERS) c.register(type).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    server = await app.resolve(HttpServer);
    // start() binds every interface; the routes answer their own errors, so listening on loopback is enough.
    await new Promise<void>((resolve) => server.Server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    server.Server.closeAllConnections();
    await new Promise<void>((resolve) => server.Server.close(() => resolve()));
    await app.dispose();
  });

  it('answers 400 for a date that does not parse, in every request part', async () => {
    const refused = [
      req().get('datetime-hydrator/query?at=garbage'),
      req().get('datetime-hydrator/query?at=1e20'),
      req().get('datetime-hydrator/param/garbage'),
      req().get('datetime-hydrator/header').set('x-at', 'Date: garbage'),
      req().post('datetime-hydrator/body').send({ at: 1e20, note: 'n' }),
    ];

    for (const pending of refused) {
      const res = await pending.set('Accept', 'application/json');

      expect(res.status, res.text).to.eq(400);
      expect(res.body.detail).to.eq(NOT_A_DATE);
    }
  });

  it('hands valid and absent dates to the action as before', async () => {
    const iso = await req().get('datetime-hydrator/query?at=2022-06-28T20:59:55Z').set('Accept', 'application/json');
    expect(iso.status, iso.text).to.eq(200);
    expect(iso.body).to.deep.eq({ valid: true, millis: Date.UTC(2022, 5, 28, 20, 59, 55) });

    const header = await req().get('datetime-hydrator/header').set('x-at', 'Date: Wed, 21 Oct 2015 07:28:00 GMT').set('Accept', 'application/json');
    expect(header.status, header.text).to.eq(200);
    expect(header.body).to.deep.eq({ millis: Date.UTC(2015, 9, 21, 7, 28, 0) });

    const body = await req().post('datetime-hydrator/body').send({ at: 1656367511, note: 'n' }).set('Accept', 'application/json');
    expect(body.status, body.text).to.eq(200);
    expect(body.body).to.deep.eq({ millis: 1656367511000, note: 'n' });

    const absent = await req().get('datetime-hydrator/query').set('Accept', 'application/json');
    expect(absent.status, absent.text).to.eq(200);
    expect(absent.body).to.deep.eq({ valid: false, millis: null });
  });
});
