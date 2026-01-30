import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { getPlinkoStateKey, getPlinkoRoundBetsKey } from 'src/redis/redis.keys';
import { GamePhase } from '../dto/game-state';
import { AuthenticatedSocket } from 'src/common/types/socket.types';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PlinkoBetService {
    private readonly logger = new Logger(PlinkoBetService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly http: HttpService
    ) { }

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
        if (!stocks || stocks.length === 0 || stocks.length > 20) throw new BadRequestException('Invalid stock selection');

        // B. WALLET DEDUCTION
        const transactionId = uuidv4();
        let deduction;

        try {
            deduction = await this.http.placeBet({
                sessionToken: client.session.sessionToken,
                betAmount: amount,
                currency: typeof client.session.currency === 'string' ? client.session.currency : (client.session.currency as any)?.name || 'USD',
                transactionId,
                metadata: { game: 'plinko', roundId: state.roundId, stocks, tenantId }
            });
        } catch (e) {
            throw new BadRequestException('Wallet deduction failed');
        }

        if (deduction.data.status !== 'SUCCESS') {
            throw new BadRequestException('Insufficient balance');
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
            currency: typeof client.session.currency === 'string' ? client.session.currency : (client.session.currency as any)?.name || 'USD',
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

        return {
            status: 'ACCEPTED',
            newBalance: deduction.data.newBalance,
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