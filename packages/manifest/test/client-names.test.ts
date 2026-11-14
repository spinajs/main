import { expect } from 'chai';
import 'mocha';
import { controllerKey } from '../src/index.js';

describe('controllerKey', () => {
  it('drops the Controller suffix and lowers the first letter', () => {
    expect(controllerKey({ className: 'UsersController' })).to.equal('users');
    expect(controllerKey({ className: 'AppProfilesController' })).to.equal('appProfiles');
  });

  it('keeps a name without the suffix, and only strips it at the end', () => {
    expect(controllerKey({ className: 'Users' })).to.equal('users');
    expect(controllerKey({ className: 'ControllerHub' })).to.equal('controllerHub');
  });
});
