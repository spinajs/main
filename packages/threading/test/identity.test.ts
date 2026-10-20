import { expect } from 'chai';
import { hostname } from 'os';
import { createProcessIdentity, processIdentity, MAX_PROCESS_IDENTITY_LENGTH } from '../src/identity.js';

describe('processIdentity', () => {
  it('Should be stable within one process', () => {
    expect(processIdentity()).to.eq(processIdentity());
  });

  it('Should contain the host, the pid and a random part', () => {
    const id = processIdentity();

    expect(id).to.match(/:\d+:[0-9a-f]{6}$/);
    expect(id).to.contain(`:${process.pid}:`);
    expect(hostname().endsWith(id.split(':')[0])).to.be.true;
    expect(id.length).to.be.at.most(MAX_PROCESS_IDENTITY_LENGTH);
  });

  it('Should differ between two processes with the same host and pid', () => {
    expect(createProcessIdentity('host', 1)).to.not.eq(createProcessIdentity('host', 1));
  });

  it('Should keep the tail of a long hostname within the column limit', () => {
    const id = createProcessIdentity('my-app-deployment-7d9f8c6b5-x2k4p', 4194304);

    expect(id.length).to.be.at.most(MAX_PROCESS_IDENTITY_LENGTH);
    expect(id).to.match(/x2k4p:4194304:[0-9a-f]{6}$/);
  });
});
