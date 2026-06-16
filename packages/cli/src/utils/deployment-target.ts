import type { createApplianceClient, Environment } from '@appliance.sh/sdk';

type Client = ReturnType<typeof createApplianceClient>;

/**
 * Resolve a project + environment name pair to the environment record.
 * Throws with a clear message when either name isn't found. Shared by
 * the observability commands (`appliance logs`, `deployment health`)
 * that need the environment's `stackName` to select its pods.
 */
export async function resolveEnvironment(
  client: Client,
  projectName: string,
  environmentName: string
): Promise<Environment> {
  const projects = await client.listProjects();
  if (!projects.success) throw new Error(`Failed to list projects: ${projects.error.message}`);
  const project = projects.data.find((p) => p.name === projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const envs = await client.listEnvironments(project.id);
  if (!envs.success) throw new Error(`Failed to list environments: ${envs.error.message}`);
  const env = envs.data.find((e) => e.name === environmentName);
  if (!env) throw new Error(`Environment not found: ${projectName}/${environmentName}`);
  return env;
}
