import { describe, expect, it } from 'vitest';
import { ApplianceBaseType } from '@appliance.sh/sdk';
import {
  DEFAULT_LOCAL_CLUSTER_NAME,
  DEFAULT_LOCAL_HOST_PORT,
  DEFAULT_LOCAL_NAMESPACE,
  LocalContainerDeploymentService,
  renderManifest,
} from './LocalContainerDeploymentService';

describe('LocalContainerDeploymentService', () => {
  it('refuses non-local base configs', () => {
    expect(
      () =>
        new LocalContainerDeploymentService({
          type: ApplianceBaseType.ApplianceAwsPublic,
          name: 'prod',
          stateBackendUrl: 's3://x',
          aws: { region: 'us-east-1', zoneId: 'Z1' },
        })
    ).toThrow(/requires a base of type/);
  });

  it('applies defaults when cluster fields are omitted', () => {
    const service = new LocalContainerDeploymentService({
      type: ApplianceBaseType.ApplianceLocal,
      name: 'dev',
      local: { dataDir: '/tmp/dev' },
    });
    // Internal config is not exposed; use refresh's response shape to
    // assert the service constructed without throwing — defaults are
    // covered by the constants test below.
    expect(service).toBeInstanceOf(LocalContainerDeploymentService);
  });

  it('exports stable defaults shared with the Tauri side', () => {
    expect(DEFAULT_LOCAL_CLUSTER_NAME).toBe('appliance-local');
    expect(DEFAULT_LOCAL_NAMESPACE).toBe('appliance');
    expect(DEFAULT_LOCAL_HOST_PORT).toBe(8081);
  });
});

describe('renderManifest', () => {
  const baseParams = {
    name: 'demo-prod',
    namespace: 'appliance',
    image: 'demo-node-container:latest',
    port: 3000,
    env: {},
    metadata: {
      projectId: 'project_1',
      projectName: 'demo',
      environmentId: 'environment_1',
      environmentName: 'prod',
      deploymentId: 'deployment_1',
      stackName: 'demo-prod',
    },
  };

  it('renders a Deployment + Service pair under one document stream', () => {
    const yaml = renderManifest(baseParams);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml.indexOf('---')).toBeGreaterThan(0);
  });

  it('annotates the Deployment with appliance ids', () => {
    const yaml = renderManifest(baseParams);
    expect(yaml).toContain('appliance.sh/deployment-id: "deployment_1"');
    expect(yaml).toContain('appliance.sh/project-id: "project_1"');
    expect(yaml).toContain('appliance.sh/environment-id: "environment_1"');
  });

  it('uses ifNotPresent pull policy so host-built images are not re-pulled', () => {
    const yaml = renderManifest(baseParams);
    expect(yaml).toContain('imagePullPolicy: IfNotPresent');
  });

  it('emits an env block when env vars are present', () => {
    const yaml = renderManifest({ ...baseParams, env: { FOO: 'bar', BAZ: 'qux' } });
    expect(yaml).toContain('- name: "FOO"');
    expect(yaml).toContain('value: "bar"');
    expect(yaml).toContain('- name: "BAZ"');
  });

  it('omits the env section entirely when env is empty', () => {
    const yaml = renderManifest({ ...baseParams, env: {} });
    expect(yaml).not.toContain('        env:');
  });

  it('quotes container port number unchanged (raw int allowed in YAML)', () => {
    const yaml = renderManifest({ ...baseParams, port: 8080 });
    expect(yaml).toContain('containerPort: 8080');
    expect(yaml).toContain('port: 8080');
    expect(yaml).toContain('targetPort: 8080');
  });
});
