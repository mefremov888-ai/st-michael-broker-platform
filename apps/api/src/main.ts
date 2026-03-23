import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: process.env.WEB_URL || 'http://localhost:3000',
    credentials: true,
  });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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
  SwaggerModule.setup('api', app, document);

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
  console.log(`🚀 API server running on port ${port}`);
  console.log(`📚 Swagger docs available at http://localhost:${port}/api`);
}

bootstrap();