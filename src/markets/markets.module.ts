import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MarketStatusService } from './market-status.service';
import { RedisModule } from 'src/redis/redis.module';

@Module({
    imports: [ConfigModule, forwardRef(() => RedisModule)],
    providers: [MarketStatusService],
    exports: [MarketStatusService],
})
export class MarketsModule { }
