import { Module } from '@nestjs/common';
import { PulumiService } from './pulumi.service';
import { PulumiController } from './pulumi.controller';

@Module({
  providers: [PulumiService],
  controllers: [PulumiController],
})
export class PulumiModule {}
