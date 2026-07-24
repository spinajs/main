import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import './../src/dto/index.js';

/**
 * `@Schema` registers each schema under the decorated class's name in the
 * '__schemas__' DI map. That map is exactly what DtoSchemaProvider reads when
 * http-swagger expands a `@returns {StatsResponse}` tag into a component, so a
 * name missing here means a missing schema in the generated OpenAPI document.
 *
 * The map is held in the DI *cache*, and sibling suites call `DI.clearCache()`
 * in their hooks, which drops the container's reference to it before this suite
 * runs. The Map object itself survives, so it is captured here at module load —
 * the moment right after the decorators ran — and asserted against below.
 */
const SCHEMAS = DI.get<Map<string, any>>('__schemas__');

describe('telemetry response DTOs', () => {
  const NAMES = ['StatsResponse', 'TimelineResponse', 'RoutesResponse', 'PerfResponse', 'HealthResponse', 'ReadyResponse'];

  it('registers every response DTO under its class name', () => {
    expect(SCHEMAS, '__schemas__ map').to.not.be.null;
    expect(SCHEMAS, '__schemas__ map').to.not.be.undefined;

    for (const name of NAMES) {
      expect(SCHEMAS!.get(name), `${name} is not registered`).to.not.be.undefined;
    }
  });

  it('declares each schema as an object with properties', () => {
    for (const name of NAMES) {
      const schema = SCHEMAS!.get(name);
      expect(schema.type, `${name}.type`).to.eq('object');
      expect(Object.keys(schema.properties ?? {}), `${name}.properties`).to.not.have.length(0);
    }
  });
});

describe('telemetry public barrel', () => {
  /**
   * The controllers are found and mounted by reflection's file scan of
   * `dist/controllers`. Re-exporting them from the package barrel would import
   * the modules a SECOND time under a different specifier, and every route
   * would end up registered twice. Nothing but review guards that, so pin it.
   */
  it('does not export the controllers', async () => {
    const barrel = await import('./../src/index.js');

    expect(Object.keys(barrel)).to.not.include('TelemetryController');
    expect(Object.keys(barrel)).to.not.include('MetricsController');
  });
});
