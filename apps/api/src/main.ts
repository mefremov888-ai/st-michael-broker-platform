import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { ZodExceptionFilter } from './common/zod-exception.filter';

// Fix BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security
  app.use(helmet());
  app.use(compression());

  // 2026-06-15: amoCRM шлёт webhook в формате form-urlencoded с вложенными
  // ключами вроде leads[update][0][id]=12345. По умолчанию NestJS поднимает
  // express.urlencoded({extended:false}) — такой парсер оставляет ключи
  // плоскими: data['leads[update][0][id]'], data.id остаётся undefined,
  // syncBrokerAttachmentFromLead не находит лид. Переключаем на extended.
  const express = require('express');
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));

  // CORS
  app.enableCors({
    origin: process.env.WEB_URL || 'http://localhost:3000',
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 2026-06-03: ZodError → 400 с понятным сообщением (раньше падало 500).
  app.useGlobalFilters(new ZodExceptionFilter());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('ST Michael Broker Platform API')
    .setDescription('API for broker management platform')
    .setVersion('1.0')
    .addTag('auth', 'Authentication endpoints')
    .addTag('clients', 'Client management')
    .addTag('deals', 'Deal management')
    .addTag('catalog', 'Property catalog')
    .addTag('commission', 'Commission calculation')
    .addTag('meetings', 'Meeting management')
    .addTag('calls', 'Call management')
    .addTag('notifications', 'Notification system')
    .addTag('documents', 'Document management')
    .addTag('analytics', 'Analytics and reporting')
    .addTag('webhooks', 'External webhooks')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
  console.log(`🚀 API server running on port ${port}`);
  console.log(`📚 Swagger docs available at http://localhost:${port}/api`);
}

bootstrap();