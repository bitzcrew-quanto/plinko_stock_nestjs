import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { EventsGateway } from 'src/events/events.gateway';
import {
    getPlinkoRoundBetsKey,
    getPlinkoGlobalLeaderboardKey,
    getPlinkoMarketHistoryKey,
    getPlinkoPlayerHistoryKey,
    getKeyForPlayerSession
} from 'src/redis/redis.keys';
import { PlinkoResult } from './plinko-engine';
import { v4 as uuidv4 } from 'uuid';
import { BalanceUpdateService } from 'src/redis/balance-update.service';
import { RTPTrackerService } from './rtp-tracker.service';

interface BetBreakdown {
    betId: string;
    stocks: string[];
    wager: number;
    payout: number;
    multiplier: number;
}

@Injectable()
export class PlinkoPayoutService {
    private readonly logger = new Logger(PlinkoPayoutService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly http: HttpService,
        private readonly events: EventsGateway,
        private readonly balanceService: BalanceUpdateService,
        private readonly rtpTracker: RTPTrackerService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    ) { }

    async processRoundPayouts(market: string, roundId: string) {
        this.logger.log(`Starting Payouts for ${market}:${roundId}`);

        const resultsRaw = await this.redis.get(`plinko:${market}:${roundId}:results`);
        const betsKey = getPlinkoRoundBetsKey(market, roundId);

        if (!resultsRaw) {
            await this.redis.del(betsKey);
            return;
        }

        const results: PlinkoResult[] = JSON.parse(resultsRaw);
        const historyKey = getPlinkoMarketHistoryKey(market);

        const topResult = results.reduce((prev, current) =>
            (prev.multiplier > current.multiplier) ? prev : current
        );

        const historyEntry = {
            id: roundId,
            t: Date.now(),
            top: { s: topResult.stockName, m: topResult.multiplier },
            res: results.map(r => ({ s: r.stockName, m: r.multiplier }))
        };

        const pipe = this.redis.getStateClient().multi();
        pipe.lPush(historyKey, JSON.stringify(historyEntry));
        pipe.lTrim(historyKey, 0, 19);
        await pipe.exec();

        this.events.server.to(market).emit('history_update', historyEntry);

        const allBetsMap = await this.redis.getStateClient().hGetAll(betsKey);

        if (!allBetsMap || Object.keys(allBetsMap).length === 0) {
            await this.redis.del(betsKey);
            await this.redis.del(`plinko:${market}:${roundId}:results`);
            return;
        }

        const stockMultipliers = new Map<string, number>();
        results.forEach(r => stockMultipliers.set(r.stockName, r.multiplier));

        const payoutPromises: Promise<void>[] = [];
        let roundTotalBet = 0;
        let roundTotalWon = 0;
        let roundTotalLost = 0;
        let playerCount = 0;

        const leaderboardKey = getPlinkoGlobalLeaderboardKey();

        for (const [playerId, betsJson] of Object.entries(allBetsMap)) {
            try {
                let userBets = JSON.parse(betsJson);
                if (!Array.isArray(userBets)) userBets = [userBets];

                let totalWager = 0;
                let totalPayout = 0;
                let maxMultiplier = 0;
                const betBreakdowns: BetBreakdown[] = [];
                let tenantId = '';
                let currency = 'USD';

                for (const bet of userBets) {
                    if (bet.tenantId) tenantId = bet.tenantId;
                    currency = typeof bet.currency === 'string' ? bet.currency : (bet.currency as any)?.name || 'USD';
                    totalWager += bet.amount;

                    let betWin = 0;
                    if (bet.stocks?.length > 0) {
                        const betPerStock = bet.amount / bet.stocks.length;
                        for (const stock of bet.stocks) {
                            const m = stockMultipliers.get(stock) || 0;
                            betWin += (betPerStock * m);
                        }
                    }

                    const currentMultiplier = betWin > 0 ? (betWin / bet.amount) : 0;
                    if (currentMultiplier > maxMultiplier) maxMultiplier = currentMultiplier;

                    totalPayout += betWin;
                    betBreakdowns.push({
                        betId: bet.transactionId,
                        stocks: bet.stocks,
                        wager: bet.amount,
                        payout: Number(betWin.toFixed(2)),
                        multiplier: Number(currentMultiplier.toFixed(2))
                    });
                }

                if (totalPayout > 0 && userBets.length > 0) {
                    const aggregateBet = {
                        ...userBets[0],
                        amount: totalWager,
                        transactionId: userBets.map((b: any) => b.transactionId).join(',')
                    };
                    payoutPromises.push(this.creditPlayer(aggregateBet, totalPayout, playerId, tenantId));
                }

                roundTotalBet += totalWager;
                roundTotalWon += totalPayout;
                roundTotalLost += Math.max(0, totalWager - totalPayout);
                playerCount++;

                if (totalPayout > 0) {
                    const leaderData = JSON.stringify({
                        id: playerId.substring(0, 6) + '***',
                        payout: Number(totalPayout.toFixed(2)),
                        multiplier: Number(maxMultiplier.toFixed(2))
                    });

                    await this.redis.getStateClient().zAdd(leaderboardKey, { score: totalPayout, value: leaderData });
                    await this.redis.getStateClient().zRemRangeByRank(leaderboardKey, 0, -101);
                }

                const personalHistoryEntry = JSON.stringify({
                    roundId,
                    t: Date.now(),
                    wager: Number(totalWager.toFixed(2)),
                    payout: Number(totalPayout.toFixed(2)),
                    net: Number((totalPayout - totalWager).toFixed(2)),
                    details: betBreakdowns
                });
                const playerHistoryKey = getPlinkoPlayerHistoryKey(playerId);
                const playerPipe = this.redis.getStateClient().multi();
                playerPipe.lPush(playerHistoryKey, personalHistoryEntry);
                playerPipe.lTrim(playerHistoryKey, 0, 19);
                await playerPipe.exec();

                if (tenantId) {
                    const room = this.balanceService.getPlayerBalanceRoom(tenantId, playerId);
                    this.events.server.to(room).emit('game:payout', {
                        roundId,
                        currency,
                        totalWager: Number(totalWager.toFixed(2)),
                        totalPayout: Number(totalPayout.toFixed(2)),
                        netProfit: Number((totalPayout - totalWager).toFixed(2)),
                        bets: betBreakdowns
                    });
                }
            } catch (e) {
                this.logger.error(`Error processing bets for player ${playerId}: ${e.message}`);
            }
        }

        const updatedTop25 = await this.redis.getStateClient().zRange(leaderboardKey, 0, 24, { REV: true });
        this.events.server.emit('leaderboard_update', updatedTop25.map(l => JSON.parse(l)));

        if (roundTotalBet > 0) await this.rtpTracker.recordWin(market, roundTotalWon);

        await Promise.allSettled(payoutPromises);

        // Send end-round report to HQ (like Wheel of Fortune)
        try {
            const startSnapRaw = await this.redis.get(`plinko:${market}:${roundId}:start_snap`);
            const startSnapshot = startSnapRaw ? JSON.parse(startSnapRaw) : null;

            const opening: Record<string, number> = {};
            const closing: Record<string, number> = {};
            for (const r of results) {
                opening[r.stockName] = r.startPrice;
                closing[r.stockName] = r.endPrice;
            }

            this.http.endRound({
                gameId: this.config.gamePublicId,
                roundId,
                market,
                startTime: startSnapshot?.timestamp
                    ? new Date(startSnapshot.timestamp).toISOString()
                    : new Date(Date.now() - 60000).toISOString(),
                endTime: new Date().toISOString(),
                metadata: {
                    opening,
                    closing,
                    results: results.map(r => ({
                        stock: r.stockName,
                        deltaPercent: r.deltaPercent,
                        multiplier: r.multiplier,
                        multiplierIndex: r.multiplierIndex,
                    })),
                    stats: {
                        totalBet: Number(roundTotalBet.toFixed(2)),
                        totalWin: Number(roundTotalWon.toFixed(2)),
                        totalLost: Number(roundTotalLost.toFixed(2)),
                        playerCount,
                    },
                },
            }).catch(err => this.logger.error(`Failed to report round end: ${err.message}`));
        } catch (err) {
            this.logger.error(`Failed to build endRound payload: ${err.message}`);
        }

        await this.redis.del(betsKey);
        await this.redis.del(`plinko:${market}:${roundId}:results`);

        this.logger.log(`Payouts completed for ${market}:${roundId}`);
    }

    private async creditPlayer(bet: any, winAmount: number, playerId: string, tenantId: string) {
        const currency = typeof bet.currency === 'string' ? bet.currency : (bet.currency as any)?.name || 'USD';

        // --- DEMO MODE ---
        try {
            const sessionKey = getKeyForPlayerSession(bet.sessionToken);
            const rawSession = await this.redis.get(sessionKey);

            if (rawSession) {
                const session = JSON.parse(rawSession);

                if (session.mode === 'demo') {
                    const currentBalance = parseFloat(session.currentBalance || '0');
                    const newBalance = currentBalance + winAmount;
                    session.currentBalance = String(newBalance);
                    session.updatedAt = new Date().toISOString();
                    await this.redis.set(sessionKey, JSON.stringify(session));

                    // Emit updated balance to the player (demo)
                    if (tenantId && playerId) {
                        const room = this.balanceService.getPlayerBalanceRoom(tenantId, playerId);
                        this.events.emitBalanceUpdateToPlayerRoom(room, {
                            playerId,
                            balance: newBalance,
                            currency,
                        });
                    }
                    return;
                }
            }
        } catch (e) {
            // Ignore session read error, fallback to HQ
        }

        // --- LIVE MODE ---
        try {
            const response = await this.http.creditWin({
                sessionToken: bet.sessionToken,
                winAmount: winAmount,
                currency,
                transactionId: uuidv4(),
                type: 'credit',
                metadata: { game: 'plinko', wagerTxId: bet.transactionId }
            });

            // Emit authoritative balance update back to the player
            if (response?.data?.newBalance !== undefined && tenantId && playerId) {
                const room = this.balanceService.getPlayerBalanceRoom(tenantId, playerId);
                this.events.emitBalanceUpdateToPlayerRoom(room, {
                    playerId,
                    balance: response.data.newBalance,
                    currency,
                });
            }
        } catch (e) {
            this.logger.error(`Failed to credit ${playerId}: ${e.message}`);
        }
    }
}