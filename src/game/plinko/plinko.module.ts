import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from 'src/redis/redis.module';
import { EventsModule } from 'src/events/events.module';
import { HttpModule } from 'src/http/http.module';
import { PlinkoPriceService } from './services/price.service';
import { PlinkoEngineService } from './services/plinko-engine';
import { PlinkoGameLoopService } from './services/game-loop.service';
import { PlinkoBetService } from './services/plinko-bet';
import { PlinkoPayoutService } from './services/plinko-payout';
import { RTPTrackerService } from './services/rtp-tracker.service';
import { RTPDecisionService } from './services/rtp-decision.service';
import { PlinkoGateway } from './plinko.gateway';

@Module({
    imports: [
        ConfigModule,
        RedisModule,
        EventsModule,
        HttpModule,
    ],
    providers: [
        PlinkoPriceService,
        PlinkoEngineService,
        PlinkoGameLoopService,
        PlinkoBetService,
        PlinkoPayoutService,
        RTPTrackerService,
        RTPDecisionService,
        PlinkoGateway
    ],
    exports: [
        PlinkoPriceService,
        PlinkoEngineService,
        PlinkoBetService,
        RTPTrackerService,
        RTPDecisionService
    ],
})
export class PlinkoModule { }