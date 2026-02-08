import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';
import { MarketDataPayload } from 'src/redis/dto/market-data.dto';

export interface PlinkoResult {
    stockName: string;
    startPrice: number;
    endPrice: number;
    deltaPercent: number;
    multiplierIndex: number;
    multiplier: number;
}

@Injectable()
export class PlinkoEngineService {
    private readonly logger = new Logger(PlinkoEngineService.name);

    constructor(
        @Inject(appConfig.KEY)
        private readonly config: ConfigType<typeof appConfig>
    ) { }

    /**
     * Determines the winning multiplier index for each stock based on price performance.
     * Now uses RTP-aware decision logic instead of pure math calculation.
     */
    async calculateRoundResults(
        market: string,
        stocks: string[],
        startSnapshot: MarketDataPayload,
        endSnapshot: MarketDataPayload,
        rtpDecisionService: any // Will be injected from game-loop
    ): Promise<PlinkoResult[]> {
        // Default: [4, 2, 1.4, 0, 0.5, 0, 1.2, 1.5, 5]
        const multipliers = this.config.plinko.multipliers;
        const bins = multipliers.length;

        if (bins < 2) {
            this.logger.error('Plinko Engine Error: Config needs at least 2 multipliers.');
            return [];
        }

        // Calculate deltas for all stocks
        const stockDeltas = stocks.map(stock => {
            const start = startSnapshot.symbols[stock]?.price || 0;
            const end = endSnapshot.symbols[stock]?.price || 0;

            let delta = 0;
            if (start > 0) {
                delta = ((end - start) / start) * 100;
            }

            return {
                stockName: stock,
                delta: parseFloat(delta.toFixed(3))
            };
        });

        // Get RTP-based decisions for all stocks
        const rtpDecisions = await rtpDecisionService.determineMultiplierIndices(market, stockDeltas);

        // Build results from RTP decisions
        const results: PlinkoResult[] = rtpDecisions.map(decision => {
            const start = startSnapshot.symbols[decision.stockName]?.price || 0;
            const end = endSnapshot.symbols[decision.stockName]?.price || 0;

            return {
                stockName: decision.stockName,
                startPrice: start,
                endPrice: end,
                deltaPercent: decision.delta,
                multiplierIndex: decision.multiplierIndex,
                multiplier: decision.multiplier
            };
        });

        return results;
    }

    /**
     * Randomly selects the stocks for the round from the active market feed.
     */
    selectGameStocks(snapshot: MarketDataPayload): string[] {
        const count = this.config.plinko.stockCount;
        const allSymbols = Object.keys(snapshot.symbols || {});

        for (let i = allSymbols.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allSymbols[i], allSymbols[j]] = [allSymbols[j], allSymbols[i]];
        }

        return allSymbols.slice(0, count);
    }
}