import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApplianceStackAwsCdkService } from './appliance-stack-aws-cdk.service';

@Controller('infra')
export class ApplianceStackController {
  constructor(private readonly cdk: ApplianceStackAwsCdkService) {}

  @Post('deploy')
  @HttpCode(200)
  async deploy() {
    return await this.cdk.deploy();
  }

  @Post('destroy')
  @HttpCode(200)
  async destroy() {
    return await this.cdk.destroy();
  }
}
