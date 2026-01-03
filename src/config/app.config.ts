import { registerAs } from '@nestjs/config';

// Helper: Parse "10,5,2..." or "[10, 5, 2]" into number array
const parseMultipliers = (raw: string | undefined, defaultVal: number[]): number[] => {
    if (!raw || raw.trim() === '') return defaultVal;
    try {
        if (raw.trim().startsWith('[')) {
            return JSON.parse(raw);
        }
        return raw.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
    } catch {
        return defaultVal;
    }
};

export default registerAs('app', () => ({
    env: process.env.NODE_ENV!,
    port: parseInt(process.env.PORT || '3000', 10),
    subscribeChannels: process.env.SUBSCRIBE_CHANNELS!.split(',').map((c) => c.trim()).filter(Boolean),
    corsOrigin: process.env.CORS_ORIGIN || '*',

    gameName: process.env.GAME_NAME!,
    hqServiceUrl: process.env.HQ_SERVICE_URL!,
    hqServiceTimeout: parseInt(process.env.HQ_SERVICE_TIMEOUT || '5000', 10),

    // --- PLINKO CONFIG (9 Multipliers) ---
    plinko: {
        // 9 Bins -> 8 Rows. 
        // Layout: Crash(Left) <--> Center(Stable) <--> Moon(Right)
        // Indices: 0, 1, 2, 3, [4], 5, 6, 7, 8
        multipliers: parseMultipliers(
            process.env.PLINKO_MULTIPLIERS,
            [10, 5, 3, 1.5, 0.5, 1.5, 3, 5, 10]
        ),

        // Timings (ms)
        bettingTime: parseInt(process.env.PLINKO_BET_TIME_MS || '20000', 10),
        accumulationTime: parseInt(process.env.PLINKO_DELTA_TIME_MS || '10000', 10),
        droppingTime: parseInt(process.env.PLINKO_DROP_TIME_MS || '10000', 10),
        payoutTime: parseInt(process.env.PLINKO_PAYOUT_TIME_MS || '5000', 10),

        // Rules
        stockCount: parseInt(process.env.PLINKO_STOCK_COUNT || '20', 10),
    },

    // Redis Configs
    pubsubRedis: {
        mode: process.env.PUBSUB_REDIS_MODE || 'standalone',
        url: process.env.PUBSUB_REDIS_URL,
        host: process.env.PUBSUB_REDIS_HOST,
        port: parseInt(process.env.PUBSUB_REDIS_PORT || '6379', 10),
        tlsEnabled: process.env.PUBSUB_REDIS_TLS_ENABLED === 'true',
        username: process.env.PUBSUB_REDIS_USERNAME,
        password: process.env.PUBSUB_REDIS_PASSWORD,
        configEndpoint: process.env.PUBSUB_REDIS_CONFIG_ENDPOINT,
        tlsCaCertBase64: process.env.PUBSUB_REDIS_TLS_CA_CERT,
        clusterEndpoints: process.env.PUBSUB_REDIS_CLUSTER_ENDPOINTS ?
            process.env.PUBSUB_REDIS_CLUSTER_ENDPOINTS.split(',').map(e => {
                const [h, p] = e.split(':');
                return { host: h, port: parseInt(p || '6379') };
            }) : []
    },
    stateRedis: {
        mode: process.env.STATE_REDIS_MODE || 'standalone',
        url: process.env.STATE_REDIS_URL,
        host: process.env.STATE_REDIS_HOST,
        port: parseInt(process.env.STATE_REDIS_PORT || '6379', 10),
        tlsEnabled: process.env.STATE_REDIS_TLS_ENABLED === 'true',
        username: process.env.STATE_REDIS_USERNAME,
        password: process.env.STATE_REDIS_PASSWORD,
        configEndpoint: process.env.STATE_REDIS_CONFIG_ENDPOINT,
        tlsCaCertBase64: process.env.STATE_REDIS_TLS_CA_CERT,
        clusterEndpoints: process.env.STATE_REDIS_CLUSTER_ENDPOINTS ?
            process.env.STATE_REDIS_CLUSTER_ENDPOINTS.split(',').map(e => {
                const [h, p] = e.split(':');
                return { host: h, port: parseInt(p || '6379') };
            }) : []
    },
}));