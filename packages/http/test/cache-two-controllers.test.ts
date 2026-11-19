import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClassInfo } from '@spinajs/di';
import { DefaultControllerCache } from '../src/cache.js';
import type { BaseController } from '../src/base-controller.js';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };

const file = fileURLToPath(new URL('./cache-fixtures/two-controllers.ts', import.meta.url));

function makeCache(): DefaultControllerCache {
  const entries = new Map<string, string>();
  const cache = new DefaultControllerCache();
  Object.defineProperty(cache, 'Log', { value: noopLog });
  Object.defineProperty(cache, 'Hasher', {
    value: {
      hash: async () => 'deadbeef',
      hashData: async (data: string) => createHash('sha256').update(data).digest('hex'),
    },
  });
  Object.defineProperty(cache, 'CacheFS', {
    value: {
      exists: async (key: string) => entries.has(key),
      write: async (key: string, data: string) => {
        entries.set(key, data);
      },
      read: async (key: string) => Buffer.from(entries.get(key) ?? ''),
    },
  });
  return cache;
}

const controller = (name: string): ClassInfo<BaseController> => Object.assign(new ClassInfo<BaseController>(), { name, file });

async function inOrder<T>(order: string[], read: (name: string) => Promise<T>): Promise<Record<string, T>> {
  const result: Record<string, T> = {};
  for (const name of order) result[name] = await read(name);
  return result;
}

describe('DefaultControllerCache with two controllers in one file', function () {
  // the first parse loads typescript, slow under load
  this.timeout(60000);

  for (const order of [['FirstController', 'SecondController'], ['SecondController', 'FirstController']]) {
    it(`gives each class its own documentation when ${order[0]} is read first`, async () => {
      const cache = makeCache();
      const docs = await inOrder(order, (name) => cache.getDocumentation(controller(name)));

      expect(docs.FirstController.className).to.equal('FirstController');
      expect(docs.FirstController.classDescription).to.contain('The first controller');
      expect(Object.keys(docs.FirstController.methods)).to.deep.equal(['list']);
      expect(docs.SecondController.className).to.equal('SecondController');
      expect(docs.SecondController.classDescription).to.contain('The second controller');
      expect(Object.keys(docs.SecondController.methods)).to.deep.equal(['get']);
    });

    it(`gives each class its own parameter names when ${order[0]} is read first`, async () => {
      const cache = makeCache();
      const parameters = await inOrder(order, (name) => cache.getCache(controller(name)));

      expect(parameters.FirstController).to.deep.equal({ list: ['page'] });
      expect(parameters.SecondController).to.deep.equal({ get: ['id'] });
    });
  }
});
