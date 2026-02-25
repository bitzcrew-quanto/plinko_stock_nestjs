import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import appConfig from './config/app.config';
import { validationSchema } from './config/validation.schema';
import { RedisModule } from './redis/redis.module';
import { EventsModule } from './events/events.module';
import { MarketsModule } from './markets/markets.module';
import { PlinkoModule } from './game/plinko/plinko.module';
import { HttpModule } from './http/http.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      load: [appConfig],
    }),
    RedisModule,
    EventsModule,
    MarketsModule,
    HttpModule,
    PlinkoModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
