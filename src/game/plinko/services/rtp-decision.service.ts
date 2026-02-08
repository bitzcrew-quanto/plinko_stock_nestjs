import { Injectable, Logger, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';
import { RTPTrackerService, RTPMetrics } from './rtp-tracker.service';

export interface StockDelta {
    stockName: string;
    delta: number;
}

export interface RTPDecision {
    stockName: string;
    delta: number;
    multiplierIndex: number;
    multiplier: number;
    reason: string;
}

@Injectable()
export class RTPDecisionService {
    private readonly logger = new Logger(RTPDecisionService.name);

    constructor(
        private readonly rtpTracker: RTPTrackerService,
        @Inject(appConfig.KEY)
        private readonly config: ConfigType<typeof appConfig>,
    ) { }

    /**
     * Main RTP Decision Logic
     * Determines which multiplier index each stock should land on based on:
     * 1. Stock delta (red/yellow/green)
     * 2. Current RTP vs Desired RTP
     * 3. Play count threshold
     */
    async determineMultiplierIndices(
        market: string,
        stockDeltas: StockDelta[]
    ): Promise<RTPDecision[]> {
        const metrics = await this.rtpTracker.getRTPMetrics(market);
        const hasEnoughData = this.rtpTracker.hasEnoughData(metrics);

        // Log current RTP status
        this.rtpTracker.logRTPStatus(market, metrics);

        const multipliers = this.config.plinko.multipliers;
        const decisions: RTPDecision[] = [];

        for (const stock of stockDeltas) {
            const decision = this.selectMultiplierIndex(
                stock,
                metrics,
                hasEnoughData,
                multipliers
            );
            decisions.push(decision);
        }

        return decisions;
    }

    /**
     * Select multiplier index for a single stock based on delta and RTP
     */
    private selectMultiplierIndex(
        stock: StockDelta,
        metrics: RTPMetrics,
        hasEnoughData: boolean,
        multipliers: number[]
    ): RTPDecision {
        const desiredRTP = this.config.plinko.desiredRTP;
        const currentRTP = metrics.currentRTP;

        // Determine if we need to increase or decrease RTP
        const needsHigherRTP = hasEnoughData && currentRTP < desiredRTP;
        const needsLowerRTP = hasEnoughData && currentRTP > desiredRTP;

        let multiplierIndex: number;
        let reason: string;

        if (stock.delta < 0) {
            // RED: Delta < 0 → Land in index 3 or 5 (both are 0x)
            multiplierIndex = this.chooseFromIndices([3, 5]);
            reason = `RED (delta < 0) → Always land on 0x multiplier`;
        } else if (stock.delta === 0) {
            // YELLOW: Delta = 0 → Land in index 2, 4, or 6 (1.4, 0.5, 1.2)
            if (needsHigherRTP) {
                // Choose higher multipliers: 1.4 (index 2) or 1.2 (index 6)
                multiplierIndex = this.chooseFromIndices([2, 6]);
                reason = `YELLOW (delta = 0) + Low RTP → Choose 1.4x or 1.2x`;
            } else if (needsLowerRTP) {
                // Choose lower multiplier: 0.5 (index 4)
                multiplierIndex = 4;
                reason = `YELLOW (delta = 0) + High RTP → Choose 0.5x`;
            } else {
                // Random choice when RTP is balanced or not enough data
                multiplierIndex = this.chooseFromIndices([2, 4, 6]);
                reason = `YELLOW (delta = 0) + Balanced RTP → Random yellow slot`;
            }
        } else {
            // GREEN: Delta > 0 → Land in index 0, 1, 7, or 8 (4, 2, 1.5, 5)
            if (needsHigherRTP) {
                // Choose higher multipliers: 5 (index 8) or 4 (index 0)
                multiplierIndex = this.chooseFromIndices([0, 8]);
                reason = `GREEN (delta > 0) + Low RTP → Choose 4x or 5x`;
            } else if (needsLowerRTP) {
                // Choose lower multipliers: 1.5 (index 7) or 2 (index 1)
                multiplierIndex = this.chooseFromIndices([1, 7]);
                reason = `GREEN (delta > 0) + High RTP → Choose 1.5x or 2x`;
            } else {
                // Random choice when RTP is balanced or not enough data
                multiplierIndex = this.chooseFromIndices([0, 1, 7, 8]);
                reason = `GREEN (delta > 0) + Balanced RTP → Random green slot`;
            }
        }

        return {
            stockName: stock.stockName,
            delta: stock.delta,
            multiplierIndex,
            multiplier: multipliers[multiplierIndex],
            reason,
        };
    }

    /**
     * Randomly choose one index from an array of valid indices
     */
    private chooseFromIndices(indices: number[]): number {
        const randomIndex = Math.floor(Math.random() * indices.length);
        return indices[randomIndex];
    }

    /**
     * Log all RTP decisions for debugging and auditing
     */
    logDecisions(market: string, roundId: string, decisions: RTPDecision[]): void {
        this.logger.log(`[RTP Decisions] Market: ${market} | Round: ${roundId}`);
        decisions.forEach(d => {
            this.logger.debug(
                `  ${d.stockName}: Delta=${d.delta.toFixed(3)} → ` +
                `Index=${d.multiplierIndex} (${d.multiplier}x) | ${d.reason}`
            );
        });
    }
}
