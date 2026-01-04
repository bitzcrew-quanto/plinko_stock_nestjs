import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import appConfig from 'src/config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from 'src/events/events.gateway';
import { PlinkoPriceService } from './price.service';
import { PlinkoEngineService } from './plinko-engine';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { PlinkoPayoutService } from './plinko-payout';
import { getPlinkoStateKey, getPlinkoRoundBetsKey } from 'src/redis/redis.keys';
import { v4 as uuidv4 } from 'uuid';
import { GamePhase, PlinkoGlobalState, StockState } from './../dto/game-state';
import * as os from 'os';



@Injectable()
export class PlinkoGameLoopService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PlinkoGameLoopService.name);
    private loops: Map<string, NodeJS.Timeout> = new Map();
    private active = false;
    private readonly TIMINGS: Record<string, number>;

    private readonly instanceId = os.hostname() + '-' + uuidv4();

    constructor(
        private readonly priceService: PlinkoPriceService,
        private readonly engineService: PlinkoEngineService,
        private readonly redisService: RedisService,
        private readonly eventsGateway: EventsGateway,
        private readonly httpService: HttpService,
        private readonly payoutService: PlinkoPayoutService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    ) {
        this.TIMINGS = {
            [GamePhase.BETTING]: this.config.plinko.bettingTime,
            [GamePhase.ACCUMULATION]: this.config.plinko.accumulationTime,
            [GamePhase.DROPPING]: this.config.plinko.droppingTime,
            [GamePhase.PAYOUT]: this.config.plinko.payoutTime,
        };
    }

    onModuleInit() {
        this.active = true;
        this.logger.log(`Starting Plinko Game Loops (Instance: ${this.instanceId})...`);
        this.config.subscribeChannels.forEach(market => this.runGameLoop(market));
    }

    onModuleDestroy() {
        this.active = false;
        this.loops.forEach(t => clearTimeout(t));
    }

    /**
     * Main Loop with LEADER ELECTION.
     * Prevents duplicate game loops when scaling horizontally.
     */
    private async runGameLoop(market: string) {
        if (!this.active) return;

        const lockKey = `lock:gameloop:${market}`;
        const isLeader = await this.acquireOrExtendLock(lockKey, this.instanceId, 10000);

        if (!isLeader) {

            this.scheduleNext(market, 5000, () => this.runGameLoop(market));
            return;
        }

        try {
            const isHealthy = await this.checkMarketHealth(market);
            if (!isHealthy) {
                this.scheduleNext(market, 2000, () => this.runGameLoop(market));
                return;
            }

            await this.processGameTick(market);

        } catch (error) {
            this.logger.error(`Critical Loop Error (${market}): ${error.message}`, error.stack);
            this.scheduleNext(market, 5000, () => this.runGameLoop(market));
        }
    }

    /**
     * Atomic Leader Election Script (Lua)
     * - Returns true if lock acquired or extended.
     * - Returns false if locked by another instance.
     */
    private async acquireOrExtendLock(key: string, value: string, ttlMs: number): Promise<boolean> {
        const client = this.redisService.getStateClient();

        // Lua script:
        // If key == my_value OR key does not exist:
        //    Set key = my_value with TTL
        //    Return 1 (Success)
        // Else:
        //    Return 0 (Failed)
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("pexpire", KEYS[1], ARGV[2])
            elseif redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
                return 1
            else
                return 0
            end
        `;

        try {
            const result = await client.eval(script, {
                keys: [key],
                arguments: [value, String(ttlMs)]
            });
            return result === 1 || result === 'OK';
        } catch (e) {
            this.logger.warn(`Redis Lock Error: ${e.message}`);
            return false;
        }
    }

    /**
     * Circuit Breaker: Pauses game and refunds bets if data is stale.
     */
    private async checkMarketHealth(market: string): Promise<boolean> {
        const snapshot = await this.priceService.getMarketSnapshot(market);

        const isFresh = snapshot && this.priceService.isSnapshotFresh(snapshot, 5);

        if (!isFresh) {
            const stateKey = getPlinkoStateKey(market);
            const rawState = await this.redisService.get(stateKey);
            const state = rawState ? JSON.parse(rawState) : {};

            if (state.phase !== GamePhase.PAUSED) {
                this.logger.warn(`[Circuit Breaker] Market ${market} stale. Triggering Emergency Stop.`);

                await this.handleEmergencyClose(market);

                await this.redisService.set(stateKey, JSON.stringify({
                    phase: GamePhase.PAUSED,
                    message: 'Market data unstable',
                    nextCheck: Date.now() + 2000
                }));

                this.eventsGateway.broadcastMarketStatus(market, 'CLOSED', 'Market data unavailable');
            }
            return false;
        }

        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);
        const state = rawState ? JSON.parse(rawState) : {};

        if (state.phase === GamePhase.PAUSED) {
            this.logger.log(`[Circuit Breaker] Market ${market} recovered. Resuming.`);
            this.eventsGateway.broadcastMarketStatus(market, 'OPEN');

            await this.startBettingPhase(market);
            return false;
        }

        return true;
    }

    /**
     * 4-Phase State Machine
     */
    private async processGameTick(market: string) {
        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);

        if (!rawState) {
            await this.startBettingPhase(market); // Boot up
            return;
        }

        const state = JSON.parse(rawState) as PlinkoGlobalState;
        const now = Date.now();
        const timeLeft = state.endTime - now;

        if (timeLeft <= 0) {
            switch (state.phase) {
                case GamePhase.BETTING:
                    await this.startAccumulationPhase(market, state.roundId, state.stocks);
                    break;
                case GamePhase.ACCUMULATION:
                    await this.startDroppingPhase(market, state.roundId, state.stocks);
                    break;
                case GamePhase.DROPPING:
                    await this.startPayoutPhase(market, state.roundId, state.stocks);
                    break;
                case GamePhase.PAYOUT:
                    await this.startBettingPhase(market);
                    break;
                default:
                    await this.startBettingPhase(market);
            }
        } else {
            const nextTick = Math.min(timeLeft, 1000);
            this.scheduleNext(market, nextTick, () => this.runGameLoop(market));
        }
    }

    private async startBettingPhase(market: string) {
        const roundId = uuidv4();
        const duration = this.TIMINGS[GamePhase.BETTING];

        const snapshot = await this.priceService.getMarketSnapshot(market);

        if (!snapshot) {
            this.logger.warn(`[Game Loop] No snapshot for ${market} in Betting. Retrying.`);
            this.scheduleNext(market, 1000, () => this.runGameLoop(market));
            return;
        }

        const stockNames = this.engineService.selectGameStocks(snapshot);

        const stocks: StockState[] = stockNames.map(symbol => ({
            symbol,
            currentPrice: snapshot.symbols[symbol]?.price || 0
        }));

        const state: PlinkoGlobalState = {
            phase: GamePhase.BETTING,
            roundId,
            serverTime: Date.now(),
            endTime: Date.now() + duration,
            stocks: stocks,
            canUnbet: true,
            message: "Place your bets!"
        };

        await this.saveAndBroadcast(market, state);

        await this.redisService.set(`plinko:${market}:${roundId}:stocks`, JSON.stringify(stockNames), 300);

        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async startAccumulationPhase(market: string, roundId: string, prevStocks: StockState[]) {
        const duration = this.TIMINGS[GamePhase.ACCUMULATION];

        const snapshot = await this.priceService.getMarketSnapshot(market);

        if (!snapshot) {
            this.logger.warn(`[Game Loop] No snapshot for ${market} in Accumulation. Retrying.`);
            this.scheduleNext(market, 1000, () => this.runGameLoop(market));
            return;
        }

        const updatedStocks = prevStocks.map(s => {
            const price = snapshot.symbols[s.symbol]?.price || 0;
            return {
                ...s,
                startPrice: price,
                currentPrice: price,
                delta: 0
            };
        });

        await this.redisService.set(`plinko:${market}:${roundId}:start_snap`, JSON.stringify(snapshot), 300);

        const state: PlinkoGlobalState = {
            phase: GamePhase.ACCUMULATION,
            roundId,
            serverTime: Date.now(),
            endTime: Date.now() + duration,
            stocks: updatedStocks,
            canUnbet: false,
            message: "Bets Closed. Tracking Markets..."
        };

        await this.saveAndBroadcast(market, state);
        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async startDroppingPhase(market: string, roundId: string, prevStocks: StockState[]) {
        const duration = this.TIMINGS[GamePhase.DROPPING];

        const endSnapshot = await this.priceService.getMarketSnapshot(market);

        if (!endSnapshot) {
            this.logger.warn(`[Game Loop] No snapshot for ${market} in Dropping. Retrying.`);
            this.scheduleNext(market, 1000, () => this.runGameLoop(market));
            return;
        }

        const startRaw = await this.redisService.get(`plinko:${market}:${roundId}:start_snap`);
        const startSnapshot = startRaw ? JSON.parse(startRaw) : endSnapshot;

        const stockNames = prevStocks.map(s => s.symbol);

        const results = this.engineService.calculateRoundResults(stockNames, startSnapshot, endSnapshot);

        const updatedStocks = prevStocks.map(s => {
            const res = results.find(r => r.stockName === s.symbol);
            return {
                ...s,
                currentPrice: res?.endPrice || 0,
                delta: res?.deltaPercent || 0,
                path: res?.path || [],
                slot: res?.stockPosition || 0,
                multiplier: res?.multiplier || 0
            };
        });

        await this.redisService.set(`plinko:${market}:${roundId}:results`, JSON.stringify(results), 300);

        const state: PlinkoGlobalState = {
            phase: GamePhase.DROPPING,
            roundId,
            serverTime: Date.now(),
            endTime: Date.now() + duration,
            stocks: updatedStocks,
            canUnbet: false,
            message: "Dropping!"
        };

        await this.saveAndBroadcast(market, state);
        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async startPayoutPhase(market: string, roundId: string, prevStocks: StockState[]) {
        const duration = this.TIMINGS[GamePhase.PAYOUT];

        const state: PlinkoGlobalState = {
            phase: GamePhase.PAYOUT,
            roundId,
            serverTime: Date.now(),
            endTime: Date.now() + duration,
            stocks: prevStocks,
            canUnbet: false,
            message: "Paying Winners..."
        };

        await this.saveAndBroadcast(market, state);

        this.payoutService.processRoundPayouts(market, roundId).catch(err =>
            this.logger.error(`Payout Error: ${err.message}`)
        );

        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async saveAndBroadcast(market: string, state: PlinkoGlobalState) {
        await this.redisService.set(getPlinkoStateKey(market), JSON.stringify(state));
        this.eventsGateway.server.to(market).emit('game:state', state);
    }

    // --- EMERGENCY / REFUND LOGIC ---

    private async handleEmergencyClose(market: string) {
        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) return;

        const state = JSON.parse(rawState);

        // Only refund if bets were active (Betting or Accumulation phase)
        if (state.phase === GamePhase.BETTING || state.phase === GamePhase.ACCUMULATION) {
            this.logger.warn(`[Emergency] Cancelling Round ${state.roundId} on ${market}. Refunding bets.`);

            this.eventsGateway.server.to(market).emit('game:error', {
                code: 'ROUND_CANCELLED',
                message: 'Round cancelled due to market instability. Bets refunded.'
            });

            await this.triggerRefunds(market, state.roundId);
        }
    }

    private async triggerRefunds(market: string, roundId: string) {
        const betsKey = getPlinkoRoundBetsKey(market, roundId);
        const allBets = await this.redisService.getStateClient().hGetAll(betsKey);

        if (!allBets || Object.keys(allBets).length === 0) return;

        this.logger.log(`Processing ${Object.keys(allBets).length} refunds for ${market}:${roundId}`);

        for (const [playerId, betJson] of Object.entries(allBets)) {
            try {
                let userBets: any[] = [];
                try {
                    userBets = JSON.parse(betJson);
                } catch {
                    userBets = [JSON.parse(betJson)];
                }

                if (!Array.isArray(userBets)) userBets = [userBets];

                for (const bet of userBets) {
                    await this.httpService.creditWin({
                        sessionToken: bet.sessionToken,
                        winAmount: bet.amount,
                        currency: 'USD',
                        transactionId: uuidv4(),
                        type: 'refund',
                        metadata: { reason: 'market_outage', originalRound: roundId, originalBetId: bet.transactionId }
                    });
                }

            } catch (err) {
                this.logger.error(`Failed to refund player ${playerId}: ${err.message}`);
            }
        }

        await this.redisService.del(betsKey);
    }

    private scheduleNext(market: string, delay: number, cb: () => void) {
        if (this.loops.has(market)) clearTimeout(this.loops.get(market));
        this.loops.set(market, setTimeout(cb, delay));
    }
}