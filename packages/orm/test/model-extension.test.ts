import * as chai from 'chai';
import 'mocha';
import type { Constructor } from '@spinajs/di';
import { Model } from '../src/decorators.js';
import { ExtensionMethodCollision } from '../src/exceptions.js';
import { ModelBase } from '../src/model.js';
import { extendModel, unextendModel } from '../src/model-extension.js';

const expect = chai.expect;

interface Named {
  nameOf(): string;
}

describe('extendModel', () => {
  it('adds a member to one model class and to its rows, and to no other model', () => {
    @Model('model_extension_extended')
    class Extended extends ModelBase {
      declare static nameOf: Named['nameOf'];
      declare nameOf: Named['nameOf'];
    }
    class Child extends Extended {}
    class Other extends ModelBase {}

    extendModel(Extended, 'nameOf', {
      onModel(this: Constructor<ModelBase>): string {
        return this.name;
      },
      onRow(this: ModelBase): string {
        return `row of ${this.constructor.name}`;
      },
    });

    expect(Extended.nameOf()).to.eq('Extended');
    expect(Child.nameOf()).to.eq('Child');
    expect(new Extended().nameOf()).to.eq('row of Extended');
    expect('nameOf' in Other).to.eq(false);
    expect('nameOf' in ModelBase.prototype).to.eq(false);
    expect(Object.keys(Extended)).to.not.include('nameOf');
    expect(Object.keys(Extended.prototype)).to.not.include('nameOf');
  });

  it('replaces what it installed and removes it again', () => {
    class Again extends ModelBase {
      declare static nameOf: Named['nameOf'];
      declare nameOf: Named['nameOf'];
    }
    extendModel(Again, 'nameOf', { onModel: () => 'first', onRow: () => 'first row' });
    extendModel(Again, 'nameOf', { onModel: () => 'second', onRow: () => 'second row' });
    expect(Again.nameOf()).to.eq('second');
    expect(Again.prototype.nameOf()).to.eq('second row');

    unextendModel(Again, 'nameOf');
    expect('nameOf' in Again).to.eq(false);
    expect('nameOf' in Again.prototype).to.eq(false);
  });

  it('adds a member through an abstract model class for its concrete subclasses and their rows, and removes it again', () => {
    abstract class Shared extends ModelBase {
      declare static nameOf: Named['nameOf'];
      declare nameOf: Named['nameOf'];
    }
    @Model('model_extension_concrete')
    class Concrete extends Shared {}

    extendModel(Shared, 'nameOf', {
      onModel(this: Constructor<ModelBase>): string {
        return this.name;
      },
      onRow(this: ModelBase): string {
        return `row of ${this.constructor.name}`;
      },
    });
    expect(Concrete.nameOf()).to.eq('Concrete');
    expect(new Concrete().nameOf()).to.eq('row of Concrete');

    unextendModel(Shared, 'nameOf');
    expect(['nameOf' in Shared, 'nameOf' in Concrete, 'nameOf' in Concrete.prototype]).to.deep.eq([false, false, false]);
  });

  it('takes an abstract model and a model whose constructor takes parameters, and refuses a function that is not a model class', () => {
    abstract class Shared extends ModelBase {}
    class Labelled extends ModelBase {
      constructor(public readonly label: string) {
        super();
      }
    }
    const members = {
      onModel(this: Constructor<ModelBase>): string {
        return this.name;
      },
    };
    extendModel(Shared, 'nameOf', members);
    extendModel(Labelled, 'nameOf', members);
    expect([Object.hasOwn(Shared, 'nameOf'), Object.hasOwn(Labelled, 'nameOf')]).to.deep.eq([true, true]);
    unextendModel(Shared, 'nameOf');
    unextendModel(Labelled, 'nameOf');

    function plain(): void {}
    const arrow = (): number => 1;
    // A row's constructor is typed Function.
    const typedFunction = ModelBase.prototype.constructor;
    const refused = (): void => {
      // @ts-expect-error a plain function is not a model class
      extendModel(plain, 'nameOf', members);
      // @ts-expect-error an arrow function is not a model class
      extendModel(arrow, 'nameOf', members);
      // @ts-expect-error nor is a value typed Function
      extendModel(typedFunction, 'nameOf', members);
      // @ts-expect-error unextendModel refuses the same
      unextendModel(plain, 'nameOf');
    };
    expect(refused).to.be.a('function');
  });

  it('refuses a name the model already has, on either side, and installs nothing then', () => {
    @Model('model_extension_own')
    class Own extends ModelBase {
      public nameOf(): string {
        return 'mine';
      }
    }
    expect(() => extendModel(Own, 'nameOf', { onModel: () => 'x', onRow: () => 'y' })).to.throw(ExtensionMethodCollision, 'model extension nameOf: Own already has a member of that name');
    expect(Object.hasOwn(Own, 'nameOf')).to.eq(false);
    expect(new Own().nameOf()).to.eq('mine');
    expect(() => extendModel(Own, 'where', { onModel: () => 'x' })).to.throw(ExtensionMethodCollision, 'model extension where: Own already has a member of that name');
  });

  it('refuses the name of a ModelBase accessor without running the accessor', () => {
    class Plain extends ModelBase {}
    expect(() => extendModel(Plain, 'Container', { onRow: () => 'x' })).to.throw(ExtensionMethodCollision, 'model extension Container: Plain already has a member of that name');
  });

  it('leaves a member of the model alone when asked to remove an extension of that name', () => {
    class Kept extends ModelBase {
      public static nameOf(): string {
        return 'own';
      }
    }
    unextendModel(Kept, 'nameOf');
    expect(Kept.nameOf()).to.eq('own');
  });
});
