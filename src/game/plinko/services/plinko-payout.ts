import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { EventsGateway } from 'src/events/events.gateway';
import { getPlinkoRoundBetsKey } from 'src/redis/redis.keys';
import { PlinkoResult } from './plinko-engine';
import { v4 as uuidv4 } from 'uuid';
import { BalanceUpdateService } from 'src/redis/balance-update.service';

@Injectable()
export class PlinkoPayoutService {
    private readonly logger = new Logger(PlinkoPayoutService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly http: HttpService,
        private readonly events: EventsGateway,
        private readonly balanceService: BalanceUpdateService,
    ) { }

    async processRoundPayouts(market: string, roundId: string) {
        this.logger.log(`Starting Payouts for ${market}:${roundId}`);

        const resultsRaw = await this.redis.get(`plinko:${market}:${roundId}:results`);
        const betsKey = getPlinkoRoundBetsKey(market, roundId);
        const allBetsMap = await this.redis.getStateClient().hGetAll(betsKey);

        if (!resultsRaw || !allBetsMap || Object.keys(allBetsMap).length === 0) {
            await this.redis.del(betsKey);
            return;
        }

        const results: PlinkoResult[] = JSON.parse(resultsRaw);
        const stockMultipliers = new Map<string, number>();
        results.forEach(r => stockMultipliers.set(r.stockName, r.multiplier));

        const payoutPromises: Promise<void>[] = [];

        for (const [playerId, betsJson] of Object.entries(allBetsMap)) {
            try {
                let userBets: any[] = [];
                try {
                    userBets = JSON.parse(betsJson);
                } catch {
                    userBets = [JSON.parse(betsJson)];
                }

                let totalWager = 0;
                let totalPayout = 0;
                const betBreakdowns: {
                    betId: any;
                    stocks: any;
                    wager: any;
                    payout: number;
                    multiplier: number;
                }[] = [];
                let tenantId = '';
                let currency = 'USD';

                for (const bet of userBets) {
                    if (bet.tenantId) tenantId = bet.tenantId;
                    currency = typeof bet.currency === 'string' ? bet.currency : (bet.currency as any)?.name || 'USD';

                    totalWager += bet.amount;

                    let betWin = 0;
                    if (bet.stocks && bet.stocks.length > 0) {
                        const betPerStock = bet.amount / bet.stocks.length;
                        for (const stock of bet.stocks) {
                            const multiplier = stockMultipliers.get(stock) || 0;
                            betWin += (betPerStock * multiplier);
                        }
                    }

                    totalPayout += betWin;

                    betBreakdowns.push({
                        betId: bet.transactionId,
                        stocks: bet.stocks,
                        wager: bet.amount,
                        payout: betWin,
                        multiplier: betWin > 0 ? (betWin / bet.amount) : 0
                    });

                    if (betWin > 0) {
                        payoutPromises.push(this.creditPlayer(bet, betWin));
                    }
                }
                if (tenantId) {
                    const room = this.balanceService.getPlayerBalanceRoom(tenantId, playerId);

                    const payload = {
                        roundId,
                        currency,
                        totalWager: Number(totalWager.toFixed(2)),
                        totalPayout: Number(totalPayout.toFixed(2)),
                        netProfit: Number((totalPayout - totalWager).toFixed(2)),
                        bets: betBreakdowns
                    };

                    this.logger.log(`[Payout] Emitting to room: ${room} | Player: ${playerId} | Win: ${totalPayout}`);
                    this.events.server.to(room).emit('game:payout', payload);
                } else {
                    this.logger.warn(`Missing tenantId for player ${playerId}, cannot emit win popup.`);
                }

            } catch (e) {
                this.logger.error(`Error processing bets for player ${playerId}: ${e.message}`);
            }
        }

        await Promise.allSettled(payoutPromises);
        await this.redis.del(betsKey);
        await this.redis.del(`plinko:${market}:${roundId}:results`);
        this.logger.log(`Payouts completed for ${market}:${roundId}`);
    }

    private async creditPlayer(bet: any, winAmount: number) {
        try {
            await this.http.creditWin({
                sessionToken: bet.sessionToken,
                winAmount: winAmount,
                currency: typeof bet.currency === 'string' ? bet.currency : (bet.currency as any)?.name || 'USD',
                transactionId: uuidv4(),
                type: 'win',
                metadata: { game: 'plinko', wagerTxId: bet.transactionId }
            });
        } catch (e) {
            this.logger.error(`Failed to credit ${bet.playerId}: ${e.message}`);
        }
    }
}