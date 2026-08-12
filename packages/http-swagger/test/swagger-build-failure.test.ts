import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { TestConfiguration } from './common.js';
import { SwaggerService } from '../src/swagger-service.js';

/**
 * A controller the documentation layer cannot read is a controller to fix.
 *
 * buildSpec() used to catch per controller and only warn, so an unreadable controller
 * dropped out of the document while the endpoint still answered 200 with a spec that
 * looked complete. In this codebase that hid twenty-one operations: the builder stops at
 * a controller's first bad method, so seven warnings stood for thirteen broken arguments
 * and seven whole controllers missing.
 *
 * Now the build fails, and it fails having tried EVERY controller - one run has to name
 * every offender, otherwise fixing them is a game of whack-a-mole.
 *
 * The service is built from its prototype with stubbed collaborators: buildSpec only
 * reaches ControllersService, DocCache, Log and the two config fields, and this keeps the
 * test off a live HTTP server and out of the shared `test/controllers` fixtures ( which
 * every other suite in this package loads ).
 */
describe('Swagger spec build failure', function () {
  const controller = (name: string) => ({ name, instance: { Descriptor: { BasePath: name, Routes: new Map(), Policies: [] } } });

  function serviceWith(controllers: any[], failing: Record<string, string>) {
    const errors: string[] = [];
    const service = Object.create(SwaggerService.prototype) as SwaggerService & Record<string, unknown>;

    // @Autoinject / @Config / @Logger install DI-resolving GETTERS on the prototype, so a
    // plain assignment throws - each stub has to shadow its getter with an own property.
    const stubs: Record<string, unknown> = {
      ControllersService: { Controllers: Promise.resolve(controllers) },
      DocCache: {
        getCache: (c: { name: string }) => {
          if (failing[c.name]) {
            throw new Error(failing[c.name]);
          }
          return Promise.resolve({ className: c.name, methods: {} });
        },
      },
      SwaggerConfig: { enabled: true, title: 'test', version: '1.0.0' },
      RoutePrefix: '',
      Log: { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m), trace: () => undefined },
    };

    for (const [name, value] of Object.entries(stubs)) {
      Object.defineProperty(service, name, { value, writable: true, configurable: true });
    }

    return { service, errors };
  }

  // buildSpec resolves the OpenApiBuilder through DI, which pulls in the validator and
  // therefore needs a Configuration - the collaborators stubbed above are only the ones
  // buildSpec touches directly.
  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  it('fails the whole build when a controller cannot be documented', async () => {
    const { service } = serviceWith([controller('GoodOne')], { GoodOne: 'path argument `slide` matches no placeholder' });

    let thrown: Error | undefined;
    try {
      await service.buildSpec();
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown, 'an undocumentable controller was swallowed instead of failing the build').to.not.be.undefined;
    expect(thrown!.message).to.contain('GoodOne');
    // the underlying reason has to survive, or the developer only learns THAT it broke
    expect(thrown!.message, 'the resolver message was lost').to.contain('matches no placeholder');
  });

  it('reports every offender, not just the first', async () => {
    const controllers = [controller('AlphaController'), controller('BetaController'), controller('GammaController')];
    const { service } = serviceWith(controllers, {
      AlphaController: 'bad argument alpha',
      GammaController: 'bad argument gamma',
    });

    let thrown: Error | undefined;
    try {
      await service.buildSpec();
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).to.not.be.undefined;
    expect(thrown!.message).to.contain('AlphaController');
    expect(thrown!.message, 'the build stopped at the first offender instead of collecting them all').to.contain('GammaController');
    expect(thrown!.message).to.contain('2 controller(s)');
    // the healthy controller is not blamed
    expect(thrown!.message).to.not.contain('BetaController');
  });

  it('logs the failure at error level', async () => {
    const { service, errors } = serviceWith([controller('BadOne')], { BadOne: 'nope' });

    await service.buildSpec().catch(() => undefined);

    expect(errors.join('\n'), 'an unbuildable spec must not be reported as a warning').to.contain('BadOne');
  });

  it('builds normally when every controller is readable', async () => {
    const { service } = serviceWith([controller('FineController')], {});

    const spec = await service.buildSpec();

    expect(spec).to.have.property('paths');
  });
});
