import * as Joi from 'joi';

const redisValidationSchema = (prefix: string) => ({
    [`${prefix}_REDIS_MODE`]: Joi.string().valid('standalone', 'cluster').default('standalone'),
    [`${prefix}_REDIS_URL`]: Joi.string().uri().when(`${prefix}_REDIS_MODE`, {
        is: 'standalone',
        then: Joi.required(),
        otherwise: Joi.optional(),
    }),
    [`${prefix}_REDIS_CLUSTER_ENDPOINTS`]: Joi.string().when(`${prefix}_REDIS_MODE`, {
        is: 'cluster',
        then: Joi.required(),
        otherwise: Joi.forbidden(),
    }),
    [`${prefix}_REDIS_TLS_ENABLED`]: Joi.boolean().default(false),
    [`${prefix}_REDIS_USERNAME`]: Joi.string().optional(),
    [`${prefix}_REDIS_PASSWORD`]: Joi.string().optional(),
    [`${prefix}_REDIS_TLS_CA_CERT`]: Joi.string().base64({ paddingRequired: false }).optional(),
});

export const validationSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().default(5002),
    SUBSCRIBE_CHANNELS: Joi.string().required(),
    CORS_ORIGIN: Joi.string().default('*'),

    GAME_NAME: Joi.string().required(),
    GAME_PUBLIC_ID: Joi.string().uuid().required(),
    HQ_SERVICE_URL: Joi.string().uri().required(),
    HQ_SERVICE_TIMEOUT: Joi.number().required(),
    SIGNATURE_SECRET: Joi.string().required(),
    GAME_MIN_STOCKS_REQUIRED: Joi.number().required(),

    PLINKO_BET_TIME_MS: Joi.number().required(),
    PLINKO_DELTA_TIME_MS: Joi.number().required(),
    PLINKO_DROP_TIME_MS: Joi.number().required(),
    PLINKO_PAYOUT_TIME_MS: Joi.number().required(),
    PLINKO_STOCK_COUNT: Joi.number().required(),

    DESIRED_RTP: Joi.number().min(0).max(100).required(),
    THRESHOLD_PLAYCOUNT: Joi.number().integer().min(0).required(),
    LIMIT_PLAYCOUNT: Joi.number().integer().min(0).required(),

    ...redisValidationSchema('PUBSUB'),
    ...redisValidationSchema('STATE'),
});