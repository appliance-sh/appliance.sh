import { Controller, HttpCode, Post } from '@nestjs/common';
import { PulumiService } from './pulumi.service';

@Controller('infra')
export class PulumiController {
  constructor(private readonly pulumi: PulumiService) {}

  @Post('deploy')
  @HttpCode(200)
  async deploy() {
    return await this.pulumi.deploy();
  }

  @Post('destroy')
  @HttpCode(200)
  async destroy() {
    return await this.pulumi.destroy();
  }
}
