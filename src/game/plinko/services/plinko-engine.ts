import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';
import { MarketDataPayload } from 'src/redis/dto/market-data.dto';

export interface PlinkoResult {
    stockName: string;
    startPrice: number;
    endPrice: number;
    deltaPercent: number;
    stockPosition: number;
    multiplier: number;
    path: number[];
}

@Injectable()
export class PlinkoEngineService {
    private readonly logger = new Logger(PlinkoEngineService.name);

    constructor(
        @Inject(appConfig.KEY)
        private readonly config: ConfigType<typeof appConfig>
    ) { }

    /**
     * Determines where the 20 balls land based on stock performance.
     */
    calculateRoundResults(
        stocks: string[],
        startSnapshot: MarketDataPayload,
        endSnapshot: MarketDataPayload
    ): PlinkoResult[] {
        // 1. Load Dynamic Configuration
        const multipliers = this.config.plinko.multipliers; // [10, 5, 3, 1.5, 0.5, 1.5, 3, 5, 10]
        const bins = multipliers.length;                    // 9
        const rows = bins - 1;                              // 8 Rows

        if (bins < 2) {
            this.logger.error('Plinko Engine Error: Config needs at least 2 multipliers.');
            return [];
        }

        const results: PlinkoResult[] = [];

        for (const stock of stocks) {
            // Safe Price Extraction
            const start = startSnapshot.symbols[stock]?.price || 0;
            const end = endSnapshot.symbols[stock]?.price || 0;

            // Calculate Delta %
            let delta = 0;
            if (start > 0) {
                delta = ((end - start) / start) * 100;
            }

            // 2. Map Delta % to a Slot Index (0 to 8)
            const slotIndex = this.mapDeltaToSlot(delta, bins);

            // 3. Generate Visual Path (L/R) for Frontend
            const path = this.generatePathForSlot(slotIndex, rows);

            results.push({
                stockName: stock,
                startPrice: start,
                endPrice: end,
                deltaPercent: parseFloat(delta.toFixed(3)),
                stockPosition: slotIndex,
                multiplier: multipliers[slotIndex],
                path: path
            });
        }

        return results;
    }

    /**
     * Maps market movement to a bin.
     * Negative Delta -> Left Side (Indices < Center)
     * Positive Delta -> Right Side (Indices > Center)
     * Near Zero -> Center
     */
    private mapDeltaToSlot(delta: number, totalBins: number): number {
        // Sensitivity: How much % change moves the ball 1 slot?
        // e.g., 0.15 means 0.15% change shifts 1 slot.
        const sensitivity = 0.15;

        // For 9 bins (0-8), center is 4.0
        const center = (totalBins - 1) / 2;

        // Calculate shift
        const shift = delta / sensitivity;
        let target = Math.round(center + shift);

        // Clamp to board boundaries [0, 8]
        return Math.max(0, Math.min(totalBins - 1, target));
    }

    /**
     * Generates a randomized path that is guaranteed to land in targetSlot.
     * For Slot K, we need exactly K "Right" turns.
     */
    private generatePathForSlot(targetSlot: number, rows: number): number[] {
        const rightTurns = targetSlot;
        const leftTurns = rows - rightTurns;

        const path: number[] = [];

        // Fill buckets
        for (let i = 0; i < rightTurns; i++) path.push(1); // 1 = Right
        for (let i = 0; i < leftTurns; i++) path.push(0);  // 0 = Left

        // Fisher-Yates Shuffle for randomness
        for (let i = path.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [path[i], path[j]] = [path[j], path[i]];
        }

        return path;
    }

    /**
     * Randomly selects the 20 stocks for the round from the active market feed.
     */
    selectGameStocks(snapshot: MarketDataPayload): string[] {
        const count = this.config.plinko.stockCount;
        const allSymbols = Object.keys(snapshot.symbols || {});

        // Shuffle and Pick
        for (let i = allSymbols.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allSymbols[i], allSymbols[j]] = [allSymbols[j], allSymbols[i]];
        }

        return allSymbols.slice(0, count);
    }
}