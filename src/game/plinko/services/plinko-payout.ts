import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { EventsGateway } from 'src/events/events.gateway';
import { getPlinkoRoundBetsKey } from 'src/redis/redis.keys';
import { PlinkoResult } from './plinko-engine';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PlinkoPayoutService {
    private readonly logger = new Logger(PlinkoPayoutService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly http: HttpService,
        private readonly events: EventsGateway
    ) { }

    /**
     * Called by GameLoopService during PAYOUT phase.
     * This runs asynchronously so it doesn't block the loop timer.
     */
    async processRoundPayouts(market: string, roundId: string) {
        this.logger.log(`Starting Payouts for ${market}:${roundId}`);

        // 1. Fetch Results & Bets
        const resultsRaw = await this.redis.get(`plinko:${market}:${roundId}:results`);
        const betsKey = getPlinkoRoundBetsKey(market, roundId);
        const allBetsMap = await this.redis.getStateClient().hGetAll(betsKey);

        if (!resultsRaw || !allBetsMap || Object.keys(allBetsMap).length === 0) {
            this.logger.log(`No bets to process for ${market}:${roundId}`);
            // Cleanup anyway
            await this.redis.del(betsKey);
            return;
        }

        const results: PlinkoResult[] = JSON.parse(resultsRaw);
        // Create lookup: StockName -> Multiplier
        const stockMultipliers = new Map<string, number>();
        results.forEach(r => stockMultipliers.set(r.stockName, r.multiplier));

        const payoutPromises: Promise<void>[] = [];

        // 2. Iterate ALL Bets
        for (const [playerId, betJson] of Object.entries(allBetsMap)) {
            try {
                const bet = JSON.parse(betJson);
                let totalWin = 0;

                // Logic: Bet amount is split among selected stocks? 
                // OR Bet amount is placed on EACH? 
                // Assuming standard "basket" logic: Bet $10 on 5 stocks = $2 per stock.
                const betPerStock = bet.amount / bet.stocks.length;

                for (const stock of bet.stocks) {
                    const multiplier = stockMultipliers.get(stock) || 0;
                    totalWin += (betPerStock * multiplier);
                }

                if (totalWin > 0) {
                    payoutPromises.push(this.creditPlayer(bet, totalWin));
                }
            } catch (e) {
                this.logger.error(`Error processing bet for player ${playerId}: ${e.message}`);
            }
        }

        await Promise.allSettled(payoutPromises);

        await this.redis.del(betsKey);
        await this.redis.del(`plinko:${market}:${roundId}:results`);

        this.logger.log(`Payouts completed for ${market}:${roundId}`);
    }

    private async creditPlayer(bet: any, winAmount: number) {
        try {
            const txId = uuidv4();

            const response = await this.http.creditWin({
                sessionToken: bet.sessionToken,
                winAmount: winAmount,
                currency: bet.currency,
                transactionId: txId,
                type: 'win',
                metadata: {
                    game: 'plinko',
                    wagerTxId: bet.transactionId
                }
            });

        } catch (e) {
            this.logger.error(`Failed to credit ${bet.playerId}: ${e.message}`);
        }
    }
}