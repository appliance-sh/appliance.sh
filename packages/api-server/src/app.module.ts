import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PulumiModule } from './pulumi/pulumi.module';

@Module({
  imports: [PulumiModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
