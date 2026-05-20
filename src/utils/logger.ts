import pino from 'pino';
import { config } from '@/config.js';

export const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
