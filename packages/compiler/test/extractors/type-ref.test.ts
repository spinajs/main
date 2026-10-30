import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, createContext, extractControllers, extractServices, extractSocketControllers } from '../../src/index.js';

const global = (name: string) => ({ package: 'global', file: '', export: name });

describe('runtime type references', () => {
  describe('pkg-basic', () => {
    const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
    const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
    const file = (name: string) => loaded.sourceFiles.find((f) => f.fileName.endsWith(`/${name}`))!;
    const [users] = extractControllers(ctx, file('controller.ts'));
    const route = (h: string) => users.routes.find((r) => r.handler === h)!;

    it('refers a number argument to the global Number and a class argument to its export', () => {
      expect(route('get').params[0].runtimeType.ref).to.deep.equal(global('Number'));
      expect(route('get').params[1].runtimeType.ref).to.deep.equal(global('Boolean'));
      expect(route('create').params[0].runtimeType.ref).to.deep.equal({ package: 'pkg-basic', file: 'src/dto.ts', export: 'CreateUserDto' });
    });

    it('records no ref on return types', () => {
      expect(route('get').returnType).to.not.have.property('ref');
    });

    it('refers socket payloads to their classes, a type-only import included', () => {
      const [docs] = extractSocketControllers(ctx, file('socket.ts'));
      expect(docs.commands.find((c) => c.handler === 'open')!.payload.ref).to.deep.equal({ package: 'pkg-basic', file: 'src/socket.ts', export: 'OpenDoc' });
      expect(docs.events.find((e) => e.name === 'created')!.payload.ref).to.deep.equal({ package: 'pkg-basic', file: 'src/queue.ts', export: 'UserCreated' });
      expect(docs.commands.find((c) => c.handler === 'open')!.result).to.not.have.property('ref');
    });

    it('records tokenRef on a property inject that names no type', () => {
      const greeter = extractServices(ctx, file('services.ts')).find((s) => s.className === 'Greeter')!;
      const inject = (property: string) => greeter.propertyInjects.find((p) => p.property === property)!;
      expect(inject('clock').tokenRef).to.deep.equal({ package: 'pkg-basic', file: 'src/services.ts', export: 'Clock' });
      expect(inject('mailer')).to.not.have.property('tokenRef');
      expect(inject('greeting')).to.not.have.property('tokenRef');
    });
  });

  describe('what emitDecoratorMetadata would record', () => {
    const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
    const fn = loaded.sourceFiles
      .find((f) => f.fileName.endsWith('type-ref.ts'))!
      .statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'runtimeTypes')!;
    const refOf = (name: string) => {
      const p = fn.parameters.find((x) => (x.name as ts.Identifier).text === name)!;
      return ctx.runtimeRef(ctx.checker.getTypeAtLocation(p), p);
    };

    it('records scalars, enums, literal unions and interfaces as their global constructors', () => {
      expect(refOf('num')).to.deep.equal(global('Number'));
      expect(refOf('color')).to.deep.equal(global('String'));
      expect(refOf('level')).to.deep.equal(global('Number'));
      expect(refOf('literal')).to.deep.equal(global('String'));
      expect(refOf('flag')).to.deep.equal(global('Boolean'));
      expect(refOf('shape')).to.deep.equal(global('Object'));
      expect(refOf('loose')).to.deep.equal(global('Object'));
      expect(refOf('mixed')).to.deep.equal(global('Object'));
      expect(refOf('list')).to.deep.equal(global('Array'));
    });

    it('records library classes as globals', () => {
      expect(refOf('date')).to.deep.equal(global('Date'));
      expect(refOf('bytes')).to.deep.equal(global('Uint8Array'));
    });

    it('records the remaining documented cases', () => {
      const fn = loaded.sourceFiles.find((f) => f.fileName.endsWith('type-ref.ts'))!.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'documented')!;
      const of = (name: string) => {
        const p = fn.parameters.find((x) => (x.name as ts.Identifier).text === name)!;
        return ctx.runtimeRef(ctx.checker.getTypeAtLocation(p), p);
      };
      expect(of('buffer')).to.deep.equal(global('Buffer'));
      expect(of('big')).to.deep.equal(global('BigInt'));
      expect(of('sym')).to.deep.equal(global('Symbol'));
      expect(of('tuple')).to.deep.equal(global('Array'));
      expect(of('callback')).to.deep.equal(global('Function'));
      expect(of('nothing')).to.equal(undefined);
      expect(of('undef')).to.equal(undefined);
    });

    it('records an exported class, also behind null', () => {
      expect(refOf('exported')).to.deep.equal({ package: 'unit', file: 'type-ref.ts', export: 'Exported' });
      expect(refOf('nullable')).to.deep.equal({ package: 'unit', file: 'type-ref.ts', export: 'Exported' });
    });

    it('records a class of a dependency with a manifest fragment by its built file', () => {
      expect(refOf('foreign')).to.deep.equal({ package: '@spinajs/di', file: 'lib/container.js', export: 'Container' });
    });

    it('records no ref for a class that is not exported, with info TYP001', () => {
      expect(refOf('hidden')).to.equal(undefined);
      const diagnostic = ctx.diagnostics.find((d) => d.code === 'TYP001')!;
      expect(diagnostic.severity).to.equal('info');
      expect(diagnostic.message).to.match(/^runtime-type-not-exported: Hidden /);
      expect(diagnostic.source).to.include({ file: 'type-ref.ts' });
    });

    it('records no ref for a class of a package without a manifest fragment, with info TYP002', () => {
      expect(refOf('untracked')).to.equal(undefined);
      const diagnostic = ctx.diagnostics.find((d) => d.code === 'TYP002')!;
      expect(diagnostic.severity).to.equal('info');
      expect(diagnostic.message).to.match(/^runtime-type-not-importable: DateTime /);
    });

    describe('declarations with no runtime value', () => {
      const fn = loaded.sourceFiles.find((f) => f.fileName.endsWith('type-ref.ts'))!.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'notValues')!;
      const of = (name: string) => {
        const p = fn.parameters.find((x) => (x.name as ts.Identifier).text === name)!;
        return ctx.runtimeRef(ctx.checker.getTypeAtLocation(p), p);
      };

      it('records Object for the static side of a class, as the metadata does', () => {
        expect(of('_cls')).to.deep.equal(global('Object'));
        expect(of('_abstract')).to.deep.equal(global('Object'));
        expect(of('_instance')).to.deep.equal({ package: 'unit', file: 'type-ref.ts', export: 'Exported' });
      });

      it('records Object for a global no runtime provides', () => {
        expect(of('_element')).to.deep.equal(global('Object'));
        expect(of('_ambient')).to.deep.equal(global('Object'));
      });

      it('records Object for a declare class, which emits nothing', () => {
        expect(of('_declared')).to.deep.equal(global('Object'));
      });
    });

    it('records no ref for a class of an ambient module, with info TYP002', () => {
      const storage = loaded.sourceFiles
        .find((f) => f.fileName.endsWith('type-ref.ts'))!
        .statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'ambient')!.parameters[0];
      expect(ctx.runtimeRef(ctx.checker.getTypeAtLocation(storage), storage)).to.equal(undefined);
      expect(ctx.diagnostics.some((d) => d.code === 'TYP002' && /AsyncLocalStorage is declared in module '(node:)?async_hooks'/.test(d.message))).to.equal(true);
    });
  });
});
