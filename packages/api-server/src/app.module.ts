import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApplianceStackModule } from './cdk/appliance-stack.module';

@Module({
  imports: [ApplianceStackModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
