import { forwardRef, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { BalanceUpdateService } from './balance-update.service';
import { EventsModule } from 'src/events/events.module';
import { DeltaWorkerService } from 'src/workers/delta.service';
import { HttpService } from 'src/http/http.service';

@Module({
  imports: [forwardRef(() => EventsModule)],
  providers: [RedisService, BalanceUpdateService, DeltaWorkerService, HttpService],
  exports: [RedisService, BalanceUpdateService, DeltaWorkerService, HttpService],
})
export class RedisModule { }