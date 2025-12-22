import * as prompts from '@inquirer/prompts';
import { ApplianceInput } from '@appliance.sh/sdk';
import * as slug from 'random-word-slugs';

export const promptForApplianceName = (config?: Partial<ApplianceInput>) => {
  const name = prompts.input({
    message: `What's the name of your appliance?`,
    default: config?.name ?? slug.generateSlug(2, { format: 'kebab' }),
  });

  return name;
};
