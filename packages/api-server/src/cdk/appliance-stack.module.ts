import { Module } from '@nestjs/common';
import { ApplianceStackAwsCdkService } from './appliance-stack-aws-cdk.service';
import { ApplianceStackController } from './appliance-stack.controller';

@Module({
  providers: [ApplianceStackAwsCdkService],
  controllers: [ApplianceStackController],
})
export class ApplianceStackModule {}
