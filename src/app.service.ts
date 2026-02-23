import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import { RedisService } from './redis/redis.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async getHealthStatus() {
    let redisUp = false;
    try {
      redisUp = await this.redisService.isHealthy();
    } catch (e) {
      this.logger.error(`Redis health check failed: ${e.message}`);
    }

    const env = this.configService.get<string>('app.env') || process.env.NODE_ENV || 'development';
    const name = this.configService.get<string>('app.name') || process.env.APP_NAME || 'plinko_stock_nestjs';
    const memoryUsage = process.memoryUsage();

    return {
      status: 'success',
      data: {
        status: redisUp ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        service: {
          name,
          environment: env,
        },
        node: {
          pid: process.pid,
          uptimeSec: Math.floor(process.uptime()),
          memory: {
            rssBytes: memoryUsage.rss,
            heapUsedBytes: memoryUsage.heapUsed,
            heapTotalBytes: memoryUsage.heapTotal,
          },
        },
        host: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
        },
        checks: {
          server: { status: 'up', uptime: `${(os.uptime() / 3600).toFixed(2)} hours` },
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
          redis: { status: redisUp ? 'up' : 'down' },
        },
      },
    };
  }
}
