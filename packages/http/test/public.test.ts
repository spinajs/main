import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, Get, Ok, Policy, Public, CONTROLLED_DESCRIPTOR_SYMBOL } from '../src/index.js';
import type { IControllerDescriptor } from '../src/interfaces.js';
import { BasePolicy } from '../src/interfaces.js';

class NoPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }
  public async execute(): Promise<void> {}
}

class MethodPublic extends BaseController {
  @Get()
  @Public('health probe')
  public ping() {
    return new Ok();
  }

  @Get()
  public other() {
    return new Ok();
  }
}

@Public('whole controller is open')
class ClassPublic extends BaseController {
  @Get()
  public ping() {
    return new Ok();
  }
}

class Guarded extends BaseController {
  @Public('contradicts the policy')
  @Policy(NoPolicy)
  @Get()
  public both() {
    return new Ok();
  }
}

const descriptorOf = (c: object) => Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, c) as IControllerDescriptor;

describe('@Public', () => {
  it('records the reason on the route only, in any decorator order', () => {
    const d = descriptorOf(MethodPublic.prototype);
    expect(d.Routes.get('ping')!.Public).to.eq('health probe');
    expect(d.Routes.get('other')!.Public).to.eq(undefined);
    expect(d.Public).to.eq(undefined);
    expect(descriptorOf(Guarded.prototype).Routes.get('both')!.Public).to.eq('contradicts the policy');
  });

  it('records the reason on the controller when used on a class', () => {
    const d = descriptorOf(ClassPublic.prototype);
    expect(d.Public).to.eq('whole controller is open');
    expect(d.Routes.get('ping')!.Public).to.eq(undefined);
  });

  it('does not change the policies of the route', () => {
    expect(descriptorOf(Guarded.prototype).Routes.get('both')!.Policies).to.have.length(1);
    expect(descriptorOf(MethodPublic.prototype).Routes.get('ping')!.Policies).to.have.length(0);
  });

  it('does not leak into a subclass route that overrides a public one', () => {
    class Child extends MethodPublic {
      @Get()
      public other() {
        return new Ok();
      }
    }
    const d = descriptorOf(Child.prototype);
    expect(d.Routes.get('ping')!.Public).to.eq('health probe');
    expect(descriptorOf(MethodPublic.prototype).Routes.get('other')!.Public).to.eq(undefined);
  });

  it('refuses an empty or blank reason', () => {
    for (const reason of ['', '   ', undefined as unknown as string, 5 as unknown as string]) {
      expect(() => Public(reason)).to.throw(InvalidArgument, '@Public needs a reason');
    }
  });
});
