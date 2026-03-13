import { Inject, Injectable, OnModuleDestroy, Logger, forwardRef, OnModuleInit } from '@nestjs/common';
import { createClient, createCluster, type RedisClientType, type RedisClusterType } from 'redis';
import appConfig from '../config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from 'src/events/events.gateway';
import { DeltaWorkerService } from 'src/workers/delta.service';
import { BalanceUpdateService } from './balance-update.service';
import type { MarketDataPayload } from './dto/market-data.dto';
import { getKeyForLastMarketSnapshot, getKeyForGameValidStocks, getGameRefetchChannel, getPlinkoStateKey, getGameConfigKey } from './redis.keys';
import { HttpService } from '../http/http.service';

export type UniversalRedisClient = RedisClientType | RedisClusterType;
type RedisConfig = ConfigType<typeof appConfig>['pubsubRedis'];
export interface GameConfig {
  maxBetLimit?: number;
  [key: string]: any;
}

@Injectable()
export class RedisService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private subscriber!: UniversalRedisClient;
  private client!: UniversalRedisClient;
  private stateSubscriber!: UniversalRedisClient;
  public gameConfig: GameConfig | null = null;

  private readonly lastPayloadByMarket: Record<string, MarketDataPayload> = Object.create(null);
  private readonly validStocksByMarket: Record<string, Set<string>> = {};

  private subscriberReady = false;
  private stateSubscriberReady = false;
  private clientReady = false;
  private lastSubscribeError?: string;

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    @Inject(forwardRef(() => EventsGateway)) private eventsGateway: EventsGateway,
    private readonly deltaWorker: DeltaWorkerService,
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => BalanceUpdateService)) private balanceUpdateService: BalanceUpdateService,
  ) { }

  async onModuleInit() {
    await this.connect();
  }

  async connect() {
    try {
      this.logger.log('Initializing Redis clients for Subscriber, State, and State Subscriber...');

      this.subscriber = this.createRedisClient('Subscriber', this.config.pubsubRedis);
      this.client = this.createRedisClient('State', this.config.stateRedis);
      this.stateSubscriber = this.createRedisClient('State Subscriber', this.config.stateRedis);

      (this.subscriber).on?.('error', (err: Error) => {
        this.lastSubscribeError = err?.message;
        this.subscriberReady = false;
        this.logger.error('Redis Subscriber Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectSubscriber(), 5000);
      });
      (this.client).on?.('error', (err: Error) => {
        this.clientReady = false;
        this.logger.error('Redis State Client Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectClient(), 5000);
      });
      (this.stateSubscriber).on?.('error', (err: Error) => {
        this.lastSubscribeError = err?.message;
        this.stateSubscriberReady = false;
        this.logger.error('Redis State Subscriber Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectStateSubscriber(), 5000);
      });

      (this.subscriber).on?.('end', () => {
        this.subscriberReady = false;
        this.logger.warn('Redis Subscriber connection ended');
      });
      (this.client).on?.('end', () => {
        this.clientReady = false;
        this.logger.warn('Redis State connection ended');
      });
      (this.stateSubscriber).on?.('end', () => {
        this.stateSubscriberReady = false;
        this.logger.warn('Redis State Subscriber connection ended');
      });

      (this.subscriber).on?.('connect', () => {
        this.logger.log('Redis Subscriber connected');
      });
      (this.client).on?.('connect', () => {
        this.clientReady = true;
        this.logger.log('Redis State Client connected');
      });
      (this.stateSubscriber).on?.('connect', () => {
        this.logger.log('Redis State Subscriber connected');
      });

      await Promise.all([
        (this.subscriber).connect(),
        (this.client).connect(),
        (this.stateSubscriber).connect(),
      ]);

      // Set client ready after successful connection
      this.clientReady = true;
      this.logger.log('Redis clients connected successfully.');
      await this.subscribeToChannels();
      await this.subscribeToGameChannels();
    } catch (error) {
      this.logger.error(
        'Failed to connect Redis clients on startup. Service will continue and retry on demand.',
        error,
      );
    }
  }

  /** Simple sliding window rate limiter using Redis INCR with TTL. */
  async isAllowedRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      const nowKey = `rl:${key}`;
      const count = await (this.client).incr(nowKey);
      if (count === 1) await (this.client).expire(nowKey, windowSeconds);
      return count <= limit;
    } catch {
      return true;
    }
  }

  /** Idempotency helper. */
  async setIfNotExists(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await (this.client).set(key, '1', { NX: true, EX: ttlSeconds });
      return result === 'OK';
    } catch {
      return true;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Use Promise.race to add a timeout to the health check
      const healthCheck = (this.client).exists('health:check:noop');
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), 5000)
      );

      await Promise.race([healthCheck, timeout]);
      return this.clientReady;
    } catch (error) {
      this.logger.warn('Redis health check failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async getHealthSnapshot(): Promise<{
    stateClientOperational: boolean;
    subscriberOperational: boolean;
    stateSubscriberOperational: boolean;
    pubsubMode: string;
    stateMode: string;
    pubsubTls?: boolean;
    stateTls?: boolean;
    lastSubscribeError?: string;
    cluster?: { state?: string; knownNodes?: number; size?: number };
  }> {
    const snapshot = {
      stateClientOperational: false,
      subscriberOperational: this.subscriberReady,
      stateSubscriberOperational: this.stateSubscriberReady,
      pubsubMode: this.config.pubsubRedis.mode,
      stateMode: this.config.stateRedis.mode,
      pubsubTls: this.config.pubsubRedis.tlsEnabled,
      stateTls: this.config.stateRedis.tlsEnabled,
      lastSubscribeError: this.lastSubscribeError,
      cluster: undefined as undefined | { state?: string; knownNodes?: number; size?: number },
    };

    try {
      await (this.client).exists('health:check:noop');
      snapshot.stateClientOperational = true;
    } catch {
      snapshot.stateClientOperational = false;
    }

    if (this.config.stateRedis.mode === 'cluster' && typeof (this.client)?.sendCommand === 'function') {
      try {
        const info: string | undefined = await (this.client as any).sendCommand(['CLUSTER', 'INFO']);
        if (typeof info === 'string') {
          const map: Record<string, string> = Object.create(null);
          for (const line of info.split('\n')) {
            const [k, v] = line.split(':');
            if (k && v) map[k.trim()] = v.trim();
          }
          snapshot.cluster = {
            state: map['cluster_state'],
            knownNodes: map['cluster_known_nodes'] ? Number(map['cluster_known_nodes']) : undefined,
            size: map['cluster_size'] ? Number(map['cluster_size']) : undefined,
          };
        }
      } catch {/* ignore */ }
    }

    return snapshot;
  }

  public getStateClient(): UniversalRedisClient { return this.client; }
  public getPubSubClient(): UniversalRedisClient { return this.subscriber; }
  public getStateSubscriberClient(): UniversalRedisClient { return this.stateSubscriber; }

  /**
   * node-redis v4 factory with correct TLS/SNI handling.
   * - Cluster: prefer CONFIG_ENDPOINT → rootNodes as URLs, SNI=CONFIG_ENDPOINT.
   * - Standalone: derive SNI from REDIS_URL host.
   */
  private createRedisClient(clientName: string, config: RedisConfig): UniversalRedisClient {
    const reconnectStrategy = (retries: number) => Math.min(100 * Math.pow(2, retries), 5_000);

    if (config.mode === 'cluster') {
      this.logger.log(`Initializing Redis ${clientName} in CLUSTER mode...`);

      // rootNodes use URL shape; no ClusterNode type needed.
      let rootNodes: Array<{ url: string }>;
      if (config.configEndpoint) {
        const proto = config.tlsEnabled ? 'rediss' : 'redis';
        rootNodes = [{ url: `${proto}://${config.configEndpoint}:${config.port ?? 6379}` }];
      } else if (config.clusterEndpoints?.length) {
        const proto = config.tlsEnabled ? 'rediss' : 'redis';
        rootNodes = config.clusterEndpoints.map((ep) => ({ url: `${proto}://${ep.host}:${ep.port}` }));
      } else {
        throw new Error(`Cluster mode for ${clientName} requires configEndpoint or clusterEndpoints`);
      }

      // Build socket options: include tls only when enabled, as literal true.
      const socket: any = config.tlsEnabled
        ? { tls: true as const, servername: config.configEndpoint ?? config.clusterEndpoints?.[0]?.host, reconnectStrategy }
        : { reconnectStrategy };

      return createCluster({
        rootNodes,
        defaults: {
          username: config.username,
          password: config.password,
          socket,
        },
      });
    }

    // ---- Standalone
    this.logger.log(`Initializing Redis ${clientName} in STANDALONE mode...`);
    if (!config.url) throw new Error(`Redis URL missing for ${clientName}`);

    // Derive SNI from URL host
    let servername: string | undefined;
    try { servername = new URL(config.url).hostname; } catch { }

    // Check if URL uses rediss:// protocol or TLS is explicitly enabled
    const isTlsUrl = config.url.startsWith('rediss://');
    const shouldUseTls = config.tlsEnabled || isTlsUrl;

    const socket: any = shouldUseTls
      ? { tls: true as const, servername, reconnectStrategy }
      : { reconnectStrategy };

    return createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      socket,
    });
  }


  private readonly forcedDeltas: Record<string, { delta: number; expiresAt: number }> = {};

  public forceStockDelta(stock: string, delta: number, durationSeconds: number = 3) {
    this.forcedDeltas[stock] = {
      delta,
      expiresAt: Date.now() + durationSeconds * 1000
    };
  }

  private applyForcedDeltas(payload: MarketDataPayload): MarketDataPayload {
    const now = Date.now();
    let hasChanges = false;
    const outSymbols = { ...payload.symbols };

    for (const [stock, force] of Object.entries(this.forcedDeltas)) {
      if (now > force.expiresAt) {
        delete this.forcedDeltas[stock];
        continue;
      }

      if (outSymbols[stock]) {
        outSymbols[stock] = {
          ...outSymbols[stock],
          delta: force.delta
        };
        hasChanges = true;
      }
    }

    return hasChanges
      ? { ...payload, symbols: outSymbols }
      : payload;
  }

  private async fetchValidStocks() {
    const channels = this.config.subscribeChannels;
    for (const channel of channels) {
      this.validStocksByMarket[channel] = new Set<string>();
      const cacheKey = getKeyForGameValidStocks(this.config.gamePublicId, channel);
      const configKey = getGameConfigKey(this.config.gamePublicId);

      try {
        let cached: string | null = null;
        let cachedConfig: string | null = null;
        try {
          [cached, cachedConfig] = await Promise.all([
            (this.client).get(cacheKey),
            (this.client).get(configKey)
          ]);
        } catch (err) {
          this.logger.warn(`Failed to read stock cache for market '${channel}': ${err}`);
        }

        if (cached && cachedConfig) {
          try {
            const cachedSymbols = JSON.parse(cached);
            if (Array.isArray(cachedSymbols)) {
              this.validStocksByMarket[channel] = new Set(cachedSymbols);
              try {
                this.gameConfig = JSON.parse(cachedConfig);
                this.logger.log(`[fetchValidStocks] Redis Cache HIT for game config on '${channel} and config '${cachedConfig}'`);

                if (this.gameConfig) {
                  this.logger.log(`[fetchValidStocks] Bypassing HQ fetch for '${channel}' as cache data is valid.`);
                  continue; // Skip HQ fetch
                }
              } catch (e) {
                this.logger.warn(`Failed to parse game config from cache for ${channel}`);
              }
            }
          } catch (e) {
            this.logger.warn(`Invalid cached data for ${channel}, falling back to HQ`);
          }
        } else {
          this.logger.log(`[fetchValidStocks] Redis Cache MISS for valid stocks or config on '${channel}'.`);
        }

        let json;
        try {
          // url =const url = `${this.config.hqServiceUrl}/api/stocks?market=${channel}&gameId=${this.config.gamePublicId}&limit=40`; fir bhi check
          json = await this.httpService.fetchGameConfig(channel);
        } catch (error) {
          this.logger.error(`Failed to fetch game config for market '${channel}': ${error}`);
        }

        this.logger.debug(`HQ Response for ${channel}: ${JSON.stringify(json)}`);

        if (json.success && json.data) {
          const stocksList = Array.isArray(json.data.stocks) ? json.data.stocks : [];
          const symbolsSet = new Set<string>();
          for (const stock of stocksList) {
            if (stock.symbol) symbolsSet.add(stock.symbol);
          }

          this.validStocksByMarket[channel] = symbolsSet;
          this.logger.log(`Loaded ${symbolsSet.size} valid stocks for market '${channel}' from HQ`);

          try {
            const uniqueSymbols = Array.from(symbolsSet);
            await (this.client).set(cacheKey, JSON.stringify(uniqueSymbols), { EX: 600 });
            // Optionally cache the game config
            if (json.data.config) {
              this.gameConfig = json.data.config;
              const configKey = getGameConfigKey(this.config.gamePublicId);
              await (this.client).set(configKey, JSON.stringify(json.data.config), { EX: 600 });
              this.logger.log(`Loaded game config for ${channel} from HQ: ${JSON.stringify(json.data.config)}`);
            }
          } catch (err) {
            this.logger.warn(`Failed to cache data for ${channel}: ${err}`);
          }

        } else {
          this.logger.warn(`Invalid response format from HQ for market '${channel}'`);
        }

      } catch (error) {
        this.logger.error(`Error fetching stocks for market '${channel}'`, error);
      }
    }
  }

  private async subscribeToChannels() {
    try {
      await this.fetchValidStocks();

      const channels = this.config.subscribeChannels;

      await (this.subscriber as any).subscribe(
        channels,
        async (message: string, channel: string) => {
          try {
            const parsed = JSON.parse(message);
            const room = channel;

            const stateKey = getPlinkoStateKey(room);
            const rawState = await this.client.get(stateKey);

            if (rawState) {
              const state = JSON.parse(rawState);
              if (state.phase === 'DROPPING' || state.phase === 'PAYOUT') {
                return;
              }
            }

            let previous = this.lastPayloadByMarket[room];
            if (rawState) {
              const state = JSON.parse(rawState);
              if (state.roundId) {
                const baseSnapRaw = await this.client.get(`plinko:${room}:${state.roundId}:base_snap`);
                if (baseSnapRaw) {
                  previous = JSON.parse(baseSnapRaw) as MarketDataPayload;
                }
              }
            }

            // Filter symbols based on valid stocks for this market
            let currentPayload = parsed;
            const validStocks = this.validStocksByMarket[room];

            if (validStocks && currentPayload.symbols) {
              const beforeCount = Object.keys(currentPayload.symbols).length;

              const filteredSymbols: any = {};
              let keptCount = 0;
              for (const [key, val] of Object.entries(currentPayload.symbols)) {
                if (validStocks.has(key)) {
                  filteredSymbols[key] = val;
                  keptCount++;
                }
              }
              currentPayload = { ...currentPayload, symbols: filteredSymbols };
            }

            // If after filtering we have no stocks left, don't emit an empty snapshot.
            if (currentPayload.symbols && Object.keys(currentPayload.symbols).length === 0) {
              return;
            }

            const stockList = currentPayload.symbols ? Object.keys(currentPayload.symbols).join(', ') : 'No stocks';
            this.logger.log(`Received market snapshot for ${channel} | Stocks: ${stockList}`);

            const current: MarketDataPayload = { ...(currentPayload as any), market: room } as unknown as MarketDataPayload;

            this.deltaWorker.enrichWithDelta(current, previous)
              .then((enriched) => {
                let outbound: MarketDataPayload = 'error' in enriched ? current : enriched;

                outbound = this.applyForcedDeltas(outbound);

                (outbound as any).receivedAt = Date.now();

                this.lastPayloadByMarket[room] = outbound;
                const lastKey = getKeyForLastMarketSnapshot(room);
                (this.client).set(lastKey, JSON.stringify(outbound), { EX: 30 }).catch(() => undefined);
                this.eventsGateway.broadcastMarketDataToRoom(room, outbound);
              })
              .catch((err) => {
                let outbound = this.enrichInline(current, previous);

                // Apply any forced deltas here too
                outbound = this.applyForcedDeltas(outbound);

                (outbound as any).receivedAt = Date.now();

                this.lastPayloadByMarket[room] = outbound;
                const lastKey = getKeyForLastMarketSnapshot(room);
                (this.client).set(lastKey, JSON.stringify(outbound), { EX: 30 }).catch(() => undefined);
                this.logger.warn(`Delta worker failed, used inline enrichment for room=${room}: ${err instanceof Error ? err.message : String(err)}`);
                this.eventsGateway.broadcastMarketDataToRoom(room, outbound);
              });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Failed to parse/emit event from channel '${channel}'. Error: ${msg}`);
          }
        },
      );

      await this.subscribeToTenantChannels();

      this.subscriberReady = true;
      this.logger.log(`Subscribed to Redis channels: ${channels.join(', ')}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to subscribe to Redis channels. ${message}`);
      this.lastSubscribeError = message;
    }
  }

  private async subscribeToTenantChannels(): Promise<void> {
    try {
      if (!this.stateSubscriber) {
        this.logger.error('Redis state subscriber is not available for tenant channel subscription');
        return;
      }

      await (this.stateSubscriber).pSubscribe(
        'tenant:*:updates',
        (message: string, channel: string) => {
          try {
            if (!channel || !channel.startsWith('tenant:') || !channel.endsWith(':updates')) {
              this.logger.warn(`Received message on invalid tenant channel format: ${channel}`);
              return;
            }
            const tenantId = channel.slice('tenant:'.length, -':updates'.length);
            if (!tenantId) {
              this.logger.warn(`Invalid tenant ID extracted from channel: ${channel}`);
              return;
            }
            if (!message || message.trim().length === 0) {
              this.logger.warn(`Empty message received on tenant channel: ${channel}`);
              return;
            }

            this.balanceUpdateService.handleTenantUpdate(tenantId, message);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Failed to handle tenant update from channel '${channel}'. Error: ${msg}`);
          }
        },
      );

      this.logger.log('Subscribed to tenant balance update channels on STATE Redis (pattern: tenant:*:updates)');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to subscribe to tenant channels on STATE Redis. ${message}`);
      this.lastSubscribeError = message;
    }
  }

  private async subscribeToGameChannels(): Promise<void> {
    try {
      if (!this.stateSubscriber) {
        this.logger.error('Redis state subscriber not available for game channels');
        return;
      }
      const channel = getGameRefetchChannel(this.config.gamePublicId);
      await (this.stateSubscriber).subscribe(
        channel,
        async (message: string) => {
          try {
            this.logger.log(`Received ${channel} signal. Clearing cache and refetching stocks...`);

            for (const market of this.config.subscribeChannels) {
              const key = getKeyForGameValidStocks(this.config.gamePublicId, market);
              await (this.client).del(key);
            }
            const configKey = getGameConfigKey(this.config.gamePublicId);
            await (this.client).del(configKey);
            await this.fetchValidStocks();
          } catch (e) {
            this.logger.error(`Error processing ${channel} message`, e);
          }
        }
      );
      this.logger.log(`Subscribed to game refetch channel: ${channel}`);
    } catch (err) {
      this.logger.error('Failed to subscribe to game channels', err);
    }
  }

  // --- KV helpers ---
  async exists(key: string): Promise<boolean> {
    const result = await (this.client).exists(key);
    return result === 1;
  }
  async get(key: string): Promise<string | null> {
    return (this.client).get(key);
  }

  async del(key: string): Promise<number> {
    return (this.client).del(key);
  }

  async set(key: string, value: string | number, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await (this.client).set(key, value, { EX: ttlSeconds });
    else await (this.client).set(key, value);
  }
  async hSet(key: string, fields: Record<string, string | number>): Promise<number> {
    return (this.client).hSet(key, fields);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return (this.client).hGetAll(key);
  }
  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    return (this.client).hIncrBy(key, field, increment);
  }
  async hIncrByFloat(key: string, field: string, increment: number): Promise<number> {
    const resultString = await (this.client).hIncrByFloat(key, field, increment);
    return parseFloat(resultString);
  }
  async sMembers(key: string): Promise<string[]> {
    return (this.client).sMembers(key);
  }
  async zRangeByScore(key: string, min: number, max: number): Promise<string[]> {
    return (this.client).zRange(key, min, max, { BY: 'SCORE' });
  }

  /**
   * Inline enrichment fallback for when the worker is unavailable.
   * Computes previousPrice and delta using the last cached snapshot.
   */
  private enrichInline(current: MarketDataPayload, previous?: MarketDataPayload): MarketDataPayload {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const outSymbols: Record<string, any> = Object.create(null);
      const curr = (current as any)?.symbols ?? {};
      const prev = (previous as any)?.symbols ?? {};

      for (const [symbol, snap] of Object.entries(curr)) {
        const priceRaw: any = (snap as any)?.price;
        const price = Number.isFinite(priceRaw) ? Number(priceRaw) : 0;
        const prevPriceRaw: any = prev?.[symbol]?.price;
        const previousPrice = Number.isFinite(prevPriceRaw) ? Number(prevPriceRaw) : null;
        const lastUpdatedAtRaw: any = (snap as any)?.lastUpdatedAt;
        const lastUpdatedAt = Number.isFinite(lastUpdatedAtRaw)
          ? Number(lastUpdatedAtRaw)
          : nowSec;

        const rawDelta = previousPrice !== null ? price - previousPrice : 0;
        let delta = 0;

        if (previousPrice && previousPrice > 0) {
          delta = Number(((rawDelta / previousPrice) * 100).toFixed(2));
        }

        if (delta === 0 && rawDelta !== 0) {
          delta = rawDelta > 0 ? 0.01 : -0.01;
        }

        outSymbols[symbol] = { price, previousPrice, lastUpdatedAt, delta };
      }

      return { market: current.market, timestamp: current.timestamp, symbols: outSymbols } as MarketDataPayload;
    } catch {
      // If anything goes wrong, return current as-is
      return current;
    }
  }

  getLastMarketPayload(market: string): MarketDataPayload | undefined {
    return this.lastPayloadByMarket[market];
  }

  /** Set/refresh expiration for a key without rewriting the value. */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result: number = await (this.client).expire(key, ttlSeconds);
      return result === 1;
    } catch {
      return false;
    }
  }

  // All channel/room names are used directly without extra mapping

  private async reconnectSubscriber(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis Subscriber...');
      await (this.subscriber).connect();
      await this.subscribeToChannels();
      this.logger.log('Redis Subscriber reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis Subscriber', error);
    }
  }

  private async reconnectClient(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis State Client...');
      await (this.client).connect();
      this.clientReady = true;
      this.logger.log('Redis State Client reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis State Client', error);
    }
  }

  private async reconnectStateSubscriber(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis State Subscriber...');
      await (this.stateSubscriber).connect();
      await this.subscribeToTenantChannels();
      await this.subscribeToGameChannels();
      this.stateSubscriberReady = true;
      this.logger.log('Redis State Subscriber reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis State Subscriber', error);
    }
  }

  async reconnectAll(): Promise<void> {
    this.logger.log('Attempting to reconnect all Redis clients...');
    await Promise.allSettled([
      this.reconnectClient(),
      this.reconnectSubscriber(),
      this.reconnectStateSubscriber(),
    ]);
  }

  async onModuleDestroy() {
    const promises: Promise<void>[] = [];
    if (this.subscriber) promises.push((this.subscriber as any).quit().catch(() => undefined));
    if (this.client) promises.push((this.client as any).quit().catch(() => undefined));
    if (this.stateSubscriber) promises.push((this.stateSubscriber as any).quit().catch(() => undefined));
    await Promise.all(promises);
    this.logger.log('All Redis connections have been closed.');
  }
}