import * as prompts from '@inquirer/prompts';
import { ApplianceFramework, ApplianceInput, ApplianceType } from '@appliance.sh/sdk';
import * as slug from 'random-word-slugs';

export const promptForApplianceName = (config?: Partial<ApplianceInput>) => {
  const name = prompts.input({
    message: `What's the name of your appliance?`,
    default: config?.name ?? slug.generateSlug(2, { format: 'kebab' }),
  });

  return name;
};

export const promptForApplianceType = (config: Partial<ApplianceInput>) => {
  const type = prompts.select<ApplianceType>({
    message: `Choose a type:`,
    choices: [ApplianceType.framework, ApplianceType.container],
    default: config?.type ?? ApplianceType.framework,
  });

  return type;
};

export const promptForApplianceFramework = (config: Partial<ApplianceInput>) => {
  const framework = prompts.select<ApplianceFramework>({
    message: `Choose a framework:`,
    choices: [ApplianceFramework.Auto, ApplianceFramework.Node, ApplianceFramework.Python],
    default: (config.type === ApplianceType.framework ? config.framework : undefined) ?? ApplianceFramework.Auto,
  });

  return framework;
};

export const promptForAppliancePort = (config: Partial<ApplianceInput>) => {
  const port = prompts.number<true>({
    message: 'What port should the app listen on?',
    min: 1,
    max: 65535,
    validate: (value) => !isNaN(parseInt(`${value}`)) || 'Please enter a valid port number',
    default: (config.type === ApplianceType.container ? config.port : undefined) ?? 8080,
  });

  return port;
};
