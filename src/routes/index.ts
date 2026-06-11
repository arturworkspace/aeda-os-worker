import { Express } from 'express';
import { Agenda } from 'agenda';
import { createWebhookRouter } from './webhookInbound.js';
import { logger } from '../logger.js';

export function registerRoutes(app: Express, agenda: Agenda): void {
  const webhookRouter = createWebhookRouter(agenda);
  app.use('/webhook', webhookRouter);

  logger.info('routes registered');
}
