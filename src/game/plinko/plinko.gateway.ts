import {
    ConnectedSocket,
    MessageBody,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { UseFilters, UsePipes, ValidationPipe, Logger } from '@nestjs/common';
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

    constructor(private readonly betService: PlinkoBetService) { }

    @SubscribeMessage('place_bet')
    async handlePlaceBet(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { amount: number; stocks: string[] }
    ) {
        try {
            // this.logger.debug(`Received bet from ${client.id}: ${JSON.stringify(payload)}`);
            const result = await this.betService.placeBet(client, payload.amount, payload.stocks);
            // client.emit('bet_accepted', result); // Optional: confirm to client
            return result;
        } catch (error) {
            this.logger.error(`Bet failed for ${client.id}: ${error.message}`);
            client.emit('error', {
                type: 'bet_error',
                message: error.message
            });
        }
    }

    @SubscribeMessage('cancel_bet')
    async handleCancelBet(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() payload: { transactionId: string }
    ) {
        try {
            const result = await this.betService.cancelBet(client, payload.transactionId);
            return result;
        } catch (error) {
            client.emit('error', {
                type: 'cancel_error',
                message: error.message
            });
        }
    }
}
