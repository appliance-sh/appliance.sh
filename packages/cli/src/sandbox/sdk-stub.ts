// JavaScript source served by the sandbox in place of
// `@appliance.sh/sdk`. Manifests only need the imported names to
// exist so the evaluated module can return a plain config object;
// the real SDK schemas validate the result afterwards, outside the
// sandbox.
//
// Schemas resolve to passthrough no-ops (parse returns the input,
// safeParse always succeeds). Enums and constant arrays are mirrored
// so manifests that reference `ApplianceType.container` or similar
// still work.
export const SDK_STUB_SOURCE = `
const identity = (x) => x;
const schema = {
  parse: identity,
  safeParse: (x) => ({ success: true, data: x }),
  optional: () => schema,
  default: () => schema,
  extend: () => schema,
  pick: () => schema,
  omit: () => schema,
};

export const Appliance = identity;
export const applianceInput = schema;
export const applianceFullInput = schema;
export const applianceRuntimeConfig = schema;
export const applianceTypeBase = schema;
export const applianceTypeContainerInput = schema;
export const applianceTypeFrameworkInput = schema;
export const applianceTypeDesktopInput = schema;
export const applianceTypeOtherInput = schema;
export const applianceTypeSchema = schema;
export const dnsName = schema;
export const portInput = schema;
export const portOutput = schema;
export const Result = schema;

export const ApplianceType = Object.freeze({
  container: 'container',
  framework: 'framework',
  desktop: 'desktop',
  other: 'other',
});
export const AppliancePlatform = Object.freeze({
  LinuxAmd64: 'linux/amd64',
  LinuxArm64: 'linux/arm64',
});
export const ApplianceFramework = Object.freeze({
  Auto: 'auto',
  Python: 'python',
  Node: 'node',
  Other: 'other',
});
export const KnownDesktopPlatforms = Object.freeze([
  'macos-arm64', 'macos-x64',
  'windows-x64', 'windows-arm64',
  'linux-x64', 'linux-arm64',
]);
export const KnownDesktopBuilders = Object.freeze(['pwa', 'tauri', 'electron']);

export const VERSION = 'sandbox';
export const DeploymentStatus = Object.freeze({
  Pending: 'pending',
  Building: 'building',
  Deploying: 'deploying',
  Succeeded: 'succeeded',
  Failed: 'failed',
});

const clientStub = new Proxy({}, {
  get: () => () => { throw new Error('SDK client is not available inside the manifest sandbox'); },
});
export const createApplianceClient = () => clientStub;

export default {};
`;
