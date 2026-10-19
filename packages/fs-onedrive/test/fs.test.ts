import 'mocha';
import { expect } from 'chai';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { fsOneDrive } from '../src/index.js';

describe('fs-onedrive', function () {
  it('rejects file operations with MethodNotImplemented', async function () {
    const provider = new fsOneDrive({ name: 'onedrive' } as any);

    let error: unknown;
    try {
      await provider.read('file.txt');
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(MethodNotImplemented);
  });
});
