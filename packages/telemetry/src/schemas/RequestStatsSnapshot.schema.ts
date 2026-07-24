/**
 * Shape of `IRequestStatsSnapshot`. Reused by the stats, timeline and routes
 * responses, so it is declared once and spread into each.
 */
const RequestStatsSnapshotSchema = {
  type: 'object',
  properties: {
    requests: { type: 'number', description: 'Requests counted' },
    responses: { type: 'number', description: 'Responses counted' },
    errors: { type: 'number', description: 'Responses with status >= 400' },

    info: { type: 'number', description: '1xx responses' },
    success: { type: 'number', description: '2xx responses' },
    redirect: { type: 'number', description: '3xx responses' },
    client_error: { type: 'number', description: '4xx responses' },
    server_error: { type: 'number', description: '5xx responses' },

    total_time: { type: 'number', description: 'Summed response time in ms' },
    max_time: { type: 'number', description: 'Slowest response in ms' },
    min_time: { type: 'number', description: 'Fastest response in ms' },
    avg_time: { type: 'number', description: 'Mean response time in ms' },

    apdex_satisfied: { type: 'number', description: 'Responses within the apdex threshold' },
    apdex_tolerated: { type: 'number', description: 'Responses within 4x the apdex threshold' },
    apdex_score: { type: 'number', description: '( satisfied + tolerated / 2 ) / responses' },

    req_rate: { type: 'number', description: 'Requests per second over the window' },
    err_rate: { type: 'number', description: 'Errors per second over the window' },
  },
};

export default RequestStatsSnapshotSchema;
