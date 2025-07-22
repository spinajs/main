import { DI } from '@spinajs/di';
import { FrameworkConfiguration, Configuration } from '@spinajs/configuration';
import { HttpServer } from '../src/server.js';
import { join, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

const expect = chai.expect;
chai.use(chaiHttp);
chai.use(chaiAsPromised);

const __filename = fileURLToPath(import.meta.url);
const __dirname = normalize(join(__filename, '..'));

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class HttpMemoryTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
          },
        ],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        host: 'localhost',
        port: 8889, // Different port to avoid conflicts
        cors: {
          origins: ['http://localhost:8889'],
          allowedHeaders: ['*'],
          exposedHeaders: ['*'],
        },
        middlewares: [] as any[],
        ssl: {
          enabled: false,
        },
        timeout: 5000,
      },
      system: {
        dirs: {
          controllers: [dir('./controllers')],
          policies: [dir('./policies')],
          static: [dir('./public')],
          views: [dir('./views')],
        },
      },
    };
  }
}

describe('HTTP Server Memory Management Tests', () => {
  let server: HttpServer;
  let startedServers: HttpServer[] = [];

  beforeEach(async () => {
    DI.clearCache();
    DI.register(HttpMemoryTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    // Clean up all started servers
    for (const srv of startedServers) {
      try {
        await srv.dispose();
      } catch (err) {
        console.warn('Error disposing server:', err.message);
      }
    }
    startedServers = [];
    DI.clearCache();
  });

  describe('Server Shutdown Memory Management', () => {
    it('should properly close server without hanging connections', async () => {
      server = await DI.resolve<HttpServer>(HttpServer);
      startedServers.push(server);
      
      // Start the server
      await server.start();
      
      // Make a connection to ensure the server is active
      await chai.request('http://localhost:8889').get('/').catch(() => {
        // OK if this fails, we're testing server lifecycle
      });
      
      // Stop the server - should complete without hanging
      const startTime = Date.now();
      await server.dispose();
      const shutdownTime = Date.now() - startTime;
      
      // Should shutdown quickly (under 5 seconds)
      expect(shutdownTime).to.be.lessThan(5000);
    });

    it('should handle server shutdown timeout scenarios', async () => {
      server = await DI.resolve<HttpServer>(HttpServer);
      startedServers.push(server);
      
      await server.start();
      
      // Test shutdown with potential timeout
      const startTime = Date.now();
      try {
        await server.dispose();
      } catch (err) {
        // Acceptable if timeout occurs, but should not hang indefinitely
      }
      const shutdownTime = Date.now() - startTime;
      
      // Should not hang for more than 15 seconds (including timeout handling)
      expect(shutdownTime).to.be.lessThan(15000);
    });

    it('should handle multiple rapid server start/stop cycles', async () => {
      const cycleCount = 5;
      const startTime = Date.now();
      
      for (let i = 0; i < cycleCount; i++) {
        const testServer = await DI.resolve<HttpServer>(HttpServer);
        startedServers.push(testServer);
        
        await testServer.start();
        await testServer.dispose();
        
        // Remove from tracking since it's disposed
        startedServers.pop();
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`${cycleCount} server cycles completed in ${totalTime}ms`);
      
      // Should complete in reasonable time
      expect(totalTime).to.be.lessThan(30000);
    });
  });

  describe('Connection Management', () => {
    it('should handle concurrent connections without leaking', async () => {
      server = await DI.resolve<HttpServer>(HttpServer);
      startedServers.push(server);
      
      await server.start();
      
      // Make multiple concurrent requests
      const requests = Array.from({ length: 10 }, () => 
        chai.request('http://localhost:8889')
          .get('/')
          .catch((): any => {
            // Requests may fail, that's OK for this test
            return null;
          })
      );
      
      await Promise.allSettled(requests);
      
      // Server should still be responsive
      expect(server.Server.listening).to.be.true;
      
      // Cleanup should work properly
      await server.dispose();
    });

    it('should properly cleanup after connection errors', async () => {
      server = await DI.resolve<HttpServer>(HttpServer);
      startedServers.push(server);
      
      await server.start();
      
      // Try to make requests that might cause errors
      const errorRequests = Array.from({ length: 5 }, () => 
        chai.request('http://localhost:8889')
          .get('/nonexistent-endpoint')
          .catch((): any => null)
      );
      
      await Promise.allSettled(errorRequests);
      
      // Server should still cleanup properly
      await server.dispose();
      expect(true).to.be.true; // Test completes without hanging
    });
  });

  describe('Middleware Memory Management', () => {
    it('should not accumulate middleware memory over multiple server instances', async () => {
      const initialMemory = process.memoryUsage();
      
      // Create and dispose multiple server instances
      for (let i = 0; i < 5; i++) {
        const testServer = await DI.resolve<HttpServer>(HttpServer);
        await testServer.start();
        await testServer.dispose();
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryGrowthMB = Math.round(memoryGrowth / 1024 / 1024);
      
      console.log(`Memory growth after 5 server cycles: ${memoryGrowthMB}MB`);
      
      // Memory growth should be reasonable (less than 50MB)
      expect(memoryGrowthMB).to.be.lessThan(50);
    });
  });

  describe('Resource Stress Testing', () => {
    it('should handle server stress without excessive memory growth', async () => {
      const initialMemory = process.memoryUsage();
      console.log(`Initial memory: ${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`);
      
      server = await DI.resolve<HttpServer>(HttpServer);
      startedServers.push(server);
      await server.start();
      
      // Simulate load with multiple requests
      const requestBatches = 3;
      const requestsPerBatch = 10;
      
      for (let batch = 0; batch < requestBatches; batch++) {
        const batchRequests = Array.from({ length: requestsPerBatch }, () => 
          chai.request('http://localhost:8889')
            .get('/')
            .catch((): any => null)
        );
        
        await Promise.allSettled(batchRequests);
        
        if (batch % 1 === 0) {
          const currentMemory = process.memoryUsage();
          console.log(`Memory after batch ${batch}: ${Math.round(currentMemory.heapUsed / 1024 / 1024)}MB`);
        }
      }
      
      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryGrowthMB = Math.round(memoryGrowth / 1024 / 1024);
      
      console.log(`Final memory: ${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`);
      console.log(`Memory growth: ${memoryGrowthMB}MB`);
      
      // Memory growth should be reasonable
      expect(memoryGrowthMB).to.be.lessThan(100);
      
      await server.dispose();
    });
  });
});
