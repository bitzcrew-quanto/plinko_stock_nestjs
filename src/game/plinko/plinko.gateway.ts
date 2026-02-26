import {
    ConnectedSocket,
    MessageBody,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PlinkoBetService } from './services/plinko-bet';
import type { AuthenticatedSocket } from 'src/common/types/socket.types';

@WebSocketGateway({
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true
    }
})
export class PlinkoGateway {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(PlinkoGateway.name);

    constructor(
        private readonly betService: PlinkoBetService,
    ) { }

    @SubscribeMessage('place_bet')
    async handlePlaceBet(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { amount: number; stocks: string[] }
    ) {
        try {
            return await this.betService.placeBet(client, payload.amount, payload.stocks);
        } catch (error) {
            client.emit('error', { type: 'bet_error', message: error.message });
        }
    }

    @SubscribeMessage('cancel_bet')
    async handleCancelBet(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { transactionId: string }
    ) {
        try {
            return await this.betService.cancelBet(client, payload.transactionId);
        } catch (error) {
            client.emit('error', { type: 'cancel_error', message: error.message });
        }
    }

    @SubscribeMessage('bet_history')
    async handleGetBetHistory(@ConnectedSocket() client: AuthenticatedSocket) {
        try {
            return await this.betService.getBetHistory(client);
        } catch (error) {
            client.emit('error', { type: 'history_error', message: error.message });
        }
    }
}