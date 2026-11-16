import { Module } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository.js';
import { PrismaService } from './prisma.service.js';
import { PrivilegedDatabase } from './privileged-database.js';

@Module({
  providers: [PrismaService, PrivilegedDatabase, CatalogRepository],
  exports: [PrismaService, PrivilegedDatabase, CatalogRepository],
})
export class PersistenceModule {}
