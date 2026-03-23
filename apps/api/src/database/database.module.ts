import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

const prismaProvider = {
  provide: 'PrismaClient',
  useFactory: () => {
    const prisma = new PrismaClient({
      log: ['query', 'info', 'warn', 'error'],
    });
    return prisma;
  },
};

@Global()
@Module({
  providers: [prismaProvider],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}