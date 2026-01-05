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
     * Pure math calculation, no path generation.
     */
    calculateRoundResults(
        stocks: string[],
        startSnapshot: MarketDataPayload,
        endSnapshot: MarketDataPayload
    ): PlinkoResult[] {
        // Default: [10, 5, 3, 1.5, 0.5, 1.5, 3, 5, 10]
        const multipliers = this.config.plinko.multipliers;
        const bins = multipliers.length;

        if (bins < 2) {
            this.logger.error('Plinko Engine Error: Config needs at least 2 multipliers.');
            return [];
        }

        const results: PlinkoResult[] = [];

        for (const stock of stocks) {
            const start = startSnapshot.symbols[stock]?.price || 0;
            const end = endSnapshot.symbols[stock]?.price || 0;

            let delta = 0;
            if (start > 0) {
                delta = ((end - start) / start) * 100;
            }

            const index = this.mapDeltaToSlot(delta, bins);

            results.push({
                stockName: stock,
                startPrice: start,
                endPrice: end,
                deltaPercent: parseFloat(delta.toFixed(3)),
                multiplierIndex: index,
                multiplier: multipliers[index]
            });
        }

        return results;
    }

    /**
     * Maps market movement to a bin index.
     * * Logic:
     * - Negative Delta (Down) -> Moves Index Lower (Left)
     * - Positive Delta (Up)   -> Moves Index Higher (Right)
     * - Near Zero Delta       -> Stays at Center
     */
    private mapDeltaToSlot(delta: number, totalBins: number): number {
        // Sensitivity: How much % change moves the ball 1 slot?
        // e.g., 0.15 means 0.15% change shifts 1 slot.
        // Adjust this if you want the game to be more/less volatile to price changes.
        const sensitivity = 0.15;

        const center = (totalBins - 1) / 2;

        const shift = delta / sensitivity;
        let target = Math.round(center + shift);

        return Math.max(0, Math.min(totalBins - 1, target));
    }

    /**
     * Randomly selects the 20 stocks for the round from the active market feed.
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