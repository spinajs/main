import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL, Idempotent, Ok, Post, parseIdempotencyKey } from '../src/index.js';
import type { IControllerDescriptor } from '../src/interfaces.js';

class IdemOrdersController extends BaseController {
  @Post()
  @Idempotent()
  public create() {
    return new Ok();
  }

  @Post()
  @Idempotent({ required: true, ttl: '1h', fingerprint: 'none', maxReplyBytes: 10 })
  public pay() {
    return new Ok();
  }

  @Post()
  public plain() {
    return new Ok();
  }
}

const routeOf = (name: string) => (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, IdemOrdersController.prototype) as IControllerDescriptor).Routes.get(name)!;

describe('@Idempotent', () => {
  it('records the defaults on the route', () => {
    expect(routeOf('create').Idempotency).to.deep.equal({ required: false, ttl: '24h', fingerprint: 'body', maxReplyBytes: 1_048_576 });
  });

  it('records the given options over the defaults', () => {
    expect(routeOf('pay').Idempotency).to.deep.equal({ required: true, ttl: '1h', fingerprint: 'none', maxReplyBytes: 10 });
  });

  it('leaves a route without it unmarked', () => {
    expect(routeOf('plain').Idempotency).to.equal(undefined);
  });

  it('refuses options it cannot honour when the class is declared', () => {
    for (const options of [{ maxReplyBytes: 0 }, { maxReplyBytes: 1.5 }, { ttl: '' }, { fingerprint: 'url' }, { required: 'yes' }, { ttl: '1h', retries: 3 }, null, 'body', ['body']]) {
      expect(() => Idempotent(options as never), JSON.stringify(options)).to.throw(InvalidArgument);
    }
  });

  it('refuses a controller class', () => {
    class IdemWholeController extends BaseController {}

    expect(() => (Idempotent() as unknown as ClassDecorator)(IdemWholeController)).to.throw(InvalidArgument, 'route method');
  });
});

describe('parseIdempotencyKey', () => {
  it('takes 1 to 255 visible ASCII characters', () => {
    for (const key of ['a', 'k-1_2.3~!', 'x'.repeat(255), '550e8400-e29b-41d4-a716-446655440000']) {
      expect(parseIdempotencyKey(key)).to.equal(key);
    }
  });

  it('refuses a missing, empty, long, spaced, non-ASCII or repeated header', () => {
    // 'a, b': Node joins a repeated header with ', ', so a string[] never reaches the gate
    for (const header of [undefined, '', 'x'.repeat(256), 'a b', 'tab\t', 'zażółć', 'a, b', 'a,b', 'a;p=1']) {
      expect(parseIdempotencyKey(header), JSON.stringify(header)).to.equal(undefined);
    }
  });

  it('takes the quoted string form, which gives the same key as the bare one', () => {
    const cases: Array<[string, string]> = [
      ['"k-1"', 'k-1'],
      ['"a b"', 'a b'],
      ['"say \\"hi\\" \\\\ bye"', 'say "hi" \\ bye'],
      [`"${'x'.repeat(255)}"`, 'x'.repeat(255)],
    ];
    for (const [header, key] of cases) {
      expect(parseIdempotencyKey(header), header).to.equal(key);
    }
    expect(parseIdempotencyKey('"k-1"')).to.equal(parseIdempotencyKey('k-1'));
  });

  it('refuses a quoted key that is empty, too long, unterminated, badly escaped or has parameters', () => {
    for (const header of ['""', `"${'x'.repeat(256)}"`, '"abc', '"a\\nb"', '"a"b"', '"a";p=1', '"a"x', '"tab\t"', '"zażółć"']) {
      expect(parseIdempotencyKey(header), JSON.stringify(header)).to.equal(undefined);
    }
  });
});
