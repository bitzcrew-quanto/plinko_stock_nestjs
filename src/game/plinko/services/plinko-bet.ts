import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
    ) {}

    async placeBet(client: AuthenticatedSocket, amount: number, stocks: string[]) {
        const market = client.session.room;
        
        const stateRaw = await this.redis.get(getPlinkoStateKey(market));
        const state = stateRaw ? JSON.parse(stateRaw) : null;

        if (!state || state.phase !== GamePhase.BETTING) {
            throw new BadRequestException('Betting is closed for this round.');
        }

        if (!amount || amount <= 0) throw new BadRequestException('Invalid amount');
        if (!stocks || stocks.length === 0 || stocks.length > 20) throw new BadRequestException('Invalid stock selection');

        const transactionId = uuidv4();
        const deduction = await this.http.placeBet({
            sessionToken: client.session.sessionToken,
            betAmount: amount,
            currency: client.session.currency,
            transactionId,
            // Pass metadata for audit
            // metadata: { game: 'plinko', roundId: state.roundId, stocks } 
        });

        if (deduction.data.status !== 'SUCCESS') {
            throw new BadRequestException('Insufficient balance or wallet error');
        }

        const roundId = state.roundId;
        const betKey = getPlinkoRoundBetsKey(market, roundId);
        
        const betPayload = JSON.stringify({
            playerId: client.session.tenantPlayerId,
            amount: amount,
            stocks: stocks,
            transactionId,
            sessionToken: client.session.sessionToken,
            currency: client.session.currency
        });

        await this.redis.getStateClient().hSet(betKey, client.session.tenantPlayerId, betPayload);

        return {
            status: 'ACCEPTED',
            newBalance: deduction.data.newBalance,
            roundId
        };
    }
}