import { Schema } from '@spinajs/validation';

import StatsResponseSchema from './../schemas/StatsResponse.schema.js';
import TimelineResponseSchema from './../schemas/TimelineResponse.schema.js';
import RoutesResponseSchema from './../schemas/RoutesResponse.schema.js';
import PerfResponseSchema from './../schemas/PerfResponse.schema.js';
import HealthResponseSchema from './../schemas/HealthResponse.schema.js';
import ReadyResponseSchema from './../schemas/ReadyResponse.schema.js';

/**
 * Response shapes for the telemetry endpoints.
 *
 * These classes are never instantiated — they exist so `@Schema` registers each
 * JSON schema under the class name, which is how http-swagger resolves a
 * `@returns {StatsResponse}` JSDoc tag into a `#/components/schemas/...`
 * component. The controller imports this module so the decorators run.
 */

@Schema(StatsResponseSchema)
export class StatsResponse {}

@Schema(TimelineResponseSchema)
export class TimelineResponse {}

@Schema(RoutesResponseSchema)
export class RoutesResponse {}

@Schema(PerfResponseSchema)
export class PerfResponse {}

@Schema(HealthResponseSchema)
export class HealthResponse {}

@Schema(ReadyResponseSchema)
export class ReadyResponse {}
