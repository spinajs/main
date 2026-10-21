const nonEmpty = { type: 'string', minLength: 1 };

/** `http.bot`, part of the http configuration schema. */
export const BOT_CONFIGURATION_SCHEMA = {
  type: 'object',
  default: {},
  description: 'Bot verification for routes marked @BotCheck(name). Off unless enabled and the named check is enabled too.',
  properties: {
    enabled: { type: 'boolean', default: false },
    header: { ...nonEmpty, default: 'x-bot-token', description: 'Request header carrying the provider token.' },
    verifierHeader: { ...nonEmpty, default: 'x-bot-verifier', description: "Request header naming the verifier the token is for: the check's verifier (default) or its fallback." },
    verifiers: {
      type: 'array',
      default: [],
      description: 'BotVerifier services ({ service, name, ...adapter options }), keyed by name.',
      items: {
        type: 'object',
        required: ['service', 'name'],
        properties: { service: nonEmpty, name: nonEmpty },
      },
    },
    checks: {
      type: 'object',
      default: {},
      description: 'Keyed by the @BotCheck name.',
      additionalProperties: {
        type: 'object',
        required: ['verifier'],
        properties: {
          enabled: { type: 'boolean', default: false },
          verifier: nonEmpty,
          action: nonEmpty,
          onUnavailable: { enum: ['refuse', 'allow'], default: 'refuse', description: 'refuse: 503 bot_check_unavailable; allow: let the request through with a warning.' },
          fallback: nonEmpty,
        },
      },
    },
  },
};
