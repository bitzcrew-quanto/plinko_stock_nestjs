import { Inject, Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { getKeyForPlayerSession, getPlinkoStateKey, getPlinkoRoundBetsKey, getPlinkoPlayerHistoryKey } from 'src/redis/redis.keys';
import { GamePhase } from '../dto/game-state';
import { AuthenticatedSocket } from 'src/common/types/socket.types';
import { v4 as uuidv4 } from 'uuid';
import { RTPTrackerService } from './rtp-tracker.service';
import type { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';

@Injectable()
export class PlinkoBetService {
    private readonly logger = new Logger(PlinkoBetService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly http: HttpService,
        private readonly rtpTracker: RTPTrackerService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    ) { }

    private updateClientBalance(client: AuthenticatedSocket, newBalance: number): void {
        const safeBalance = (typeof newBalance === 'number' && !Number.isNaN(newBalance)) ? newBalance : 0;
        client.session.currentBalance = String(safeBalance);
        client.emit('updated_balance', {
            playerUpdatedBalance: safeBalance,
            currency: (client.session.currency as any)?.name || 'USD'
        });
    }

    private async updateSessionBalanceInRedis(sessionToken: string, newBalance: number): Promise<void> {
        try {
            const sessionKey = getKeyForPlayerSession(sessionToken);
            const raw = await this.redis.get(sessionKey);
            if (!raw) return;

            const session = JSON.parse(raw);
            session.currentBalance = String(newBalance);
            session.updatedAt = new Date().toISOString();
            await this.redis.set(sessionKey, JSON.stringify(session));
        } catch (error) {
            this.logger.error(`Failed to update session balance in Redis for demo: ${error}`);
        }
    }

    async placeBet(client: AuthenticatedSocket, amount: number, stocks: string[]) {
        const market = client.session.room;
        const playerId = client.session.tenantPlayerId;
        const tenantId = client.session.tenantPublicId;

        const stateRaw = await this.redis.get(getPlinkoStateKey(market));
        const state = stateRaw ? JSON.parse(stateRaw) : null;

        if (!state || state.phase !== GamePhase.BETTING) {
            throw new BadRequestException('Betting is closed for this round.');
        }

        if (!amount || amount <= 0) throw new BadRequestException('Invalid amount');
        if (!stocks || stocks.length === 0 || stocks.length > this.config.plinko.stockCount) throw new BadRequestException('Invalid stock selection');


        const transactionId = uuidv4();
        const isDemoMode = client.session.mode === 'demo';
        let newBalance = 0;

        if (isDemoMode) {
            const currentBalance = parseFloat(client.session.currentBalance || '0');
            if (!Number.isFinite(currentBalance) || amount <= 0) {
                throw new BadRequestException('Invalid bet amount');
            }
            if (amount > currentBalance) {
                throw new BadRequestException('Insufficient balance');
            }
            newBalance = currentBalance - amount;
            this.updateClientBalance(client, newBalance);
            await this.updateSessionBalanceInRedis(client.session.sessionToken, newBalance);
        } else {
            let deduction;
            try {
                deduction = await this.http.placeBet({
                    sessionToken: client.session.sessionToken,
                    betAmount: amount,
                    currency: client.session.currency.name,
                    transactionId,
                    metadata: { game: 'plinko', roundId: state.roundId, stocks, tenantId }
                });
            } catch (e) {
                throw new BadRequestException('Wallet deduction failed');
            }

            if (deduction.data.status !== 'SUCCESS') {
                throw new BadRequestException('Insufficient balance');
            }
            newBalance = deduction.data.newBalance;
        }

        const roundId = state.roundId;
        const betKey = getPlinkoRoundBetsKey(market, roundId);

        const newBet = {
            playerId,
            tenantId,
            amount,
            stocks,
            transactionId,
            sessionToken: client.session.sessionToken,
            currency: client.session.currency.name,
            placedAt: Date.now()
        };

        const script = `
            local current = redis.call('HGET', KEYS[1], ARGV[1])
            local bets = {}
            if current then
                bets = cjson.decode(current)
            end
            table.insert(bets, cjson.decode(ARGV[2]))
            redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(bets))
            return 1
        `;

        await this.redis.getStateClient().eval(script, {
            keys: [betKey],
            arguments: [playerId, JSON.stringify(newBet)]
        });

        // Track bet for RTP calculation
        await this.rtpTracker.recordBet(market, amount);

        return {
            status: 'ACCEPTED',
            newBalance,
            roundId,
            transactionId
        };
    }

    async cancelBet(client: AuthenticatedSocket, transactionId: string) {
        const market = client.session.room;
        const playerId = client.session.tenantPlayerId;

        if (!transactionId) throw new BadRequestException('Bet ID required to cancel');

        const stateRaw = await this.redis.get(getPlinkoStateKey(market));
        const state = stateRaw ? JSON.parse(stateRaw) : null;

        if (!state || state.phase !== GamePhase.BETTING) {
            throw new BadRequestException('Too late! Betting is closed.');
        }

        const betKey = getPlinkoRoundBetsKey(market, state.roundId);

        const script = `
            local current = redis.call('HGET', KEYS[1], ARGV[1])
            if not current then return nil end
            
            local bets = cjson.decode(current)
            local targetId = ARGV[2]
            local foundBet = nil
            local newBets = {}
            
            for i, bet in ipairs(bets) do
                if bet.transactionId == targetId then
                    foundBet = bet
                else
                    table.insert(newBets, bet)
                end
            end
            
            if foundBet then
                if #newBets == 0 then
                    redis.call('HDEL', KEYS[1], ARGV[1]) 
                else
                    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(newBets))
                end
                return cjson.encode(foundBet)
            else
                return nil
            end
        `;

        const removedBetString = await this.redis.getStateClient().eval(script, {
            keys: [betKey],
            arguments: [playerId, transactionId]
        });

        if (!removedBetString) {
            throw new BadRequestException('Bet not found or already cancelled.');
        }

        const bet = JSON.parse(removedBetString as string);

        const isDemoMode = client.session.mode === 'demo';

        if (isDemoMode) {
            const currentBalance = parseFloat(client.session.currentBalance || '0');
            const refundAmount = Math.max(0, bet.amount || 0);
            const newBalance = currentBalance + refundAmount;

            this.updateClientBalance(client, newBalance);
            await this.updateSessionBalanceInRedis(client.session.sessionToken, newBalance);

            return {
                status: 'CANCELLED',
                refundAmount,
                newBalance
            };
        } else {
            try {
                const refundTx = await this.http.creditWin({
                    sessionToken: client.session.sessionToken,
                    winAmount: bet.amount,
                    currency: bet.currency,
                    transactionId: uuidv4(),
                    type: 'refund',
                    metadata: { reason: 'user_cancel', originalBetId: transactionId }
                });

                return {
                    status: 'CANCELLED',
                    refundAmount: bet.amount,
                    newBalance: refundTx.data.newBalance
                };
            } catch (e) {
                this.logger.error(`CRITICAL: Refund failed for ${playerId}, bet ${transactionId}`);
                throw new InternalServerErrorException('Cancellation failed.');
            }
        }
    }

    async getBetHistory(client: AuthenticatedSocket) {
        const playerId = client.session.tenantPlayerId;
        const playerHistoryKey = getPlinkoPlayerHistoryKey(playerId);

        try {
            const historyRaw = await this.redis.getStateClient().lRange(playerHistoryKey, 0, 19);
            const history = historyRaw.map(entry => JSON.parse(entry));

            client.emit('bet_history', history);
            return history;
        } catch (error) {
            this.logger.error(`Failed to fetch bet history for player ${playerId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve bet history');
        }
    }
}