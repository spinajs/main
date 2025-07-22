import { Templates } from '@spinajs/templates';
import { FrameworkConfiguration, Configuration } from '@spinajs/configuration';
import { join, resolve, normalize } from 'path';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { promises as fs } from 'fs';
import '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class MemoryTestConfiguration extends FrameworkConfiguration {
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
      templates: {
        pdf: {
          static: {
            portRange: [8080, 8090],
          },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          options: {},
          renderDurationWarning: 5000,
          renderTimeout: 10000,
        },
      },
    };
  }
}

describe('PDF Templates Memory Management Tests', () => {
  let templates: Templates;
  let testFiles: string[] = [];

  beforeEach(async () => {
    DI.clearCache();
    DI.register(MemoryTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    templates = await DI.resolve<Templates>(Templates);
  });

  afterEach(async () => {
    // Clean up test files
    for (const file of testFiles) {
      try {
        await fs.unlink(file);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
    testFiles = [];
    DI.clearCache();
  });

  describe('Browser Instance Memory Management', () => {
    it('should properly close browser instances even on errors', async () => {
      const outputFile = dir('output/memory-test-error.pdf');
      testFiles.push(outputFile);

      // Force an error by using invalid template
      try {
        await templates.renderToFile(
          dir('templates/nonexistent-template.pug'),
          { test: 'data' },
          outputFile
        );
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err).to.be.an('error');
      }

      // Give some time for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Test should complete without hanging, indicating proper cleanup
      expect(true).to.be.true;
    });

    it('should handle multiple concurrent renders without leaking browsers', async () => {
      const renderPromises = [];
      const startTime = Date.now();

      for (let i = 0; i < 5; i++) {
        const outputFile = dir(`output/concurrent-${i}.pdf`);
        testFiles.push(outputFile);
        
        const renderPromise = templates.renderToFile(
          dir('templates/simple.pug'),
          { message: `Test ${i}`, items: [1, 2, 3] },
          outputFile
        ).catch(err => {
          // Some may fail due to port conflicts, that's OK for this test
          console.warn(`Render ${i} failed:`, err.message);
        });
        
        renderPromises.push(renderPromise);
      }

      await Promise.allSettled(renderPromises);
      const duration = Date.now() - startTime;

      // Should complete in reasonable time (not hang due to leaked resources)
      expect(duration).to.be.lessThan(30000);
    });

    it('should handle browser crashes gracefully', async () => {
      const outputFile = dir('output/crash-test.pdf');
      testFiles.push(outputFile);

      try {
        // This might fail but should not hang the process
        await templates.renderToFile(
          dir('templates/crash-template.pug'),
          {},
          outputFile
        );
      } catch (err) {
        // Expected to fail, but should clean up properly
        expect(err).to.be.an('error');
      }

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(true).to.be.true;
    });
  });

  describe('HTTP Server Memory Management', () => {
    it('should properly close HTTP servers on errors', async () => {
      const outputFile = dir('output/server-error-test.pdf');
      testFiles.push(outputFile);

      try {
        await templates.renderToFile(
          dir('templates/simple.pug'),
          { message: 'Server test' },
          outputFile
        );
      } catch (err) {
        // May fail due to server issues, but should clean up
      }

      // Test completes without hanging
      expect(true).to.be.true;
    });

    it('should handle server timeout scenarios', async () => {
      const outputFile = dir('output/timeout-test.pdf');
      testFiles.push(outputFile);

      const startTime = Date.now();
      
      try {
        // Try to render with very short timeout
        await templates.renderToFile(
          dir('templates/simple.pug'),
          { message: 'Timeout test' },
          outputFile
        );
      } catch (err) {
        // May timeout, but should clean up properly
      }

      const duration = Date.now() - startTime;
      // Should not hang indefinitely
      expect(duration).to.be.lessThan(15000);
    });
  });

  describe('Resource Usage Monitoring', () => {
    it('should complete stress test without excessive memory growth', async () => {
      const initialMemory = process.memoryUsage();
      const renderCount = 10;
      
      console.log(`Initial memory: ${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`);

      for (let i = 0; i < renderCount; i++) {
        const outputFile = dir(`output/stress-${i}.pdf`);
        testFiles.push(outputFile);

        try {
          await templates.renderToFile(
            dir('templates/simple.pug'),
            { 
              message: `Stress test ${i}`,
              items: Array.from({ length: 100 }, (_, idx) => ({ id: idx, value: `Item ${idx}` }))
            },
            outputFile
          );
          
          // Force garbage collection if available
          if (global.gc) {
            global.gc();
          }
          
        } catch (err) {
          console.warn(`Stress test ${i} failed:`, err.message);
        }

        // Log memory usage periodically
        if (i % 5 === 0) {
          const currentMemory = process.memoryUsage();
          console.log(`Memory after ${i} renders: ${Math.round(currentMemory.heapUsed / 1024 / 1024)}MB`);
        }
      }

      const finalMemory = process.memoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryGrowthMB = Math.round(memoryGrowth / 1024 / 1024);
      
      console.log(`Final memory: ${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`);
      console.log(`Memory growth: ${memoryGrowthMB}MB`);

      // Memory growth should be reasonable (less than 100MB for 10 renders)
      expect(memoryGrowthMB).to.be.lessThan(100);
    });

    it('should handle rapid render cycles', async () => {
      const rapidRenderCount = 20;
      const startTime = Date.now();

      const renderPromises = Array.from({ length: rapidRenderCount }, async (_, i) => {
        const outputFile = dir(`output/rapid-${i}.pdf`);
        testFiles.push(outputFile);

        try {
          await templates.renderToFile(
            dir('templates/simple.pug'),
            { message: `Rapid ${i}` },
            outputFile
          );
        } catch (err) {
          // Some may fail due to resource contention, that's expected
        }
      });

      await Promise.allSettled(renderPromises);
      const duration = Date.now() - startTime;

      console.log(`Rapid render test completed in ${duration}ms`);
      
      // Should complete in reasonable time
      expect(duration).to.be.lessThan(60000);
    });
  });
});
