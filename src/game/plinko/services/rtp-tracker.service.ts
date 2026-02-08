import { Injectable, Logger, Inject } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';

export interface RTPMetrics {
    totalBet: number;
    totalWon: number;
    playCount: number;
    currentRTP: number;
}

@Injectable()
export class RTPTrackerService {
    private readonly logger = new Logger(RTPTrackerService.name);

    constructor(
        private readonly redis: RedisService,
        @Inject(appConfig.KEY)
        private readonly config: ConfigType<typeof appConfig>,
    ) { }

    /**
     * Get the RTP key for a specific market
     */
    private getRTPKey(market: string): string {
        return `plinko:rtp:${market}`;
    }

    /**
     * Atomically increment bet amount and play count
     * Also checks if limit is reached and resets if necessary
     */
    async recordBet(market: string, betAmount: number): Promise<void> {
        const key = this.getRTPKey(market);
        const client = this.redis.getStateClient();

        try {
            // First, check current play count
            const currentPlayCount = await client.hGet(key, 'playCount');
            const playCount = parseInt(currentPlayCount || '0', 10);

            // Check if we've reached the limit
            const limit = this.config.plinko.rtpLimitPlayCount;
            if (playCount >= limit) {
                this.logger.warn(
                    `[RTP Reset] Market ${market} reached limit of ${limit} plays. ` +
                    `Resetting RTP metrics to start fresh cycle.`
                );
                await this.resetRTPMetrics(market);
            }

            // Record the bet
            await client.hIncrByFloat(key, 'totalBet', betAmount);
            await client.hIncrBy(key, 'playCount', 1);
        } catch (error) {
            this.logger.error(`Failed to record bet for ${market}: ${error.message}`);
        }
    }

    /**
     * Atomically increment win amount
     */
    async recordWin(market: string, winAmount: number): Promise<void> {
        const key = this.getRTPKey(market);
        const client = this.redis.getStateClient();

        try {
            await client.hIncrByFloat(key, 'totalWon', winAmount);
        } catch (error) {
            this.logger.error(`Failed to record win for ${market}: ${error.message}`);
        }
    }

    /**
     * Get current RTP metrics for a market
     */
    async getRTPMetrics(market: string): Promise<RTPMetrics> {
        const key = this.getRTPKey(market);
        const client = this.redis.getStateClient();

        try {
            const data = await client.hGetAll(key);

            const totalBet = parseFloat(data.totalBet || '0');
            const totalWon = parseFloat(data.totalWon || '0');
            const playCount = parseInt(data.playCount || '0', 10);

            const currentRTP = totalBet > 0 ? (totalWon / totalBet) * 100 : 0;

            return {
                totalBet,
                totalWon,
                playCount,
                currentRTP,
            };
        } catch (error) {
            this.logger.error(`Failed to get RTP metrics for ${market}: ${error.message}`);
            return {
                totalBet: 0,
                totalWon: 0,
                playCount: 0,
                currentRTP: 0,
            };
        }
    }

    /**
     * Reset RTP metrics for a market (admin function)
     */
    async resetRTPMetrics(market: string): Promise<void> {
        const key = this.getRTPKey(market);
        const client = this.redis.getStateClient();

        try {
            await client.del(key);
            this.logger.log(`RTP metrics reset for ${market}`);
        } catch (error) {
            this.logger.error(`Failed to reset RTP metrics for ${market}: ${error.message}`);
        }
    }

    /**
     * Check if we have enough data to make RTP adjustments
     */
    hasEnoughData(metrics: RTPMetrics): boolean {
        const threshold = this.config.plinko.rtpThresholdPlayCount;
        return metrics.playCount >= threshold;
    }

    /**
     * Log current RTP status
     */
    logRTPStatus(market: string, metrics: RTPMetrics): void {
        const desiredRTP = this.config.plinko.desiredRTP;
        const deviation = metrics.currentRTP - desiredRTP;
        const limit = this.config.plinko.rtpLimitPlayCount;
        const threshold = this.config.plinko.rtpThresholdPlayCount;
        const playsUntilReset = Math.max(0, limit - metrics.playCount);

        this.logger.log(
            `[RTP ${market}] Current: ${metrics.currentRTP.toFixed(2)}% | ` +
            `Desired: ${desiredRTP}% | Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)}% | ` +
            `Plays: ${metrics.playCount}/${limit} (${playsUntilReset} until reset) | ` +
            `Threshold: ${threshold} | Bet: ${metrics.totalBet.toFixed(2)} | Won: ${metrics.totalWon.toFixed(2)}`
        );
    }
}
