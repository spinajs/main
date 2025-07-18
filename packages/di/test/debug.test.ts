import * as chai from 'chai';
import { DI, Singleton } from '../src/index.js';

const expect = chai.expect;

@Singleton()
class DebugService {
  public static instanceCount = 0;
  
  public static initialize() {
    DebugService.instanceCount = 0;
  }
  
  constructor() {
    console.log(`DebugService constructor called, count will be: ${DebugService.instanceCount + 1}`);
    DebugService.instanceCount++;
  }
}

describe('Debug Singleton Issue', () => {
  beforeEach(() => {
    DI.clear();
    DebugService.initialize();
  });

  it('should create only one instance when resolved twice using global DI', () => {
    console.log('=== Starting test with global DI ===');
    
    console.log('First resolve...');
    const instance1 = DI.resolve(DebugService);
    console.log('First instance created');
    
    console.log('Second resolve...');
    const instance2 = DI.resolve(DebugService);
    console.log('Second instance created');
    
    console.log(`Total instances created: ${DebugService.instanceCount}`);
    console.log(`Instances are same object: ${instance1 === instance2}`);
    
    expect(DebugService.instanceCount).to.equal(1);
    expect(instance1).to.equal(instance2);
  });
});
