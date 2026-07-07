import { describe, expect, it } from 'vitest';
import { buildctlArgs, parseBuildkitMetadata } from './buildkit-image.js';

const opts = {
  name: 'demo-backend',
  context: '/work/demo/backend',
  registryUrl: 'localhost:5052',
  buildkitAddr: 'tcp://127.0.0.1:5054',
};

describe('buildctlArgs', () => {
  it('builds the dockerfile.v0 frontend against the forwarded buildkitd and pushes insecurely', () => {
    const args = buildctlArgs({ ...opts, platform: 'linux/amd64' }, '/tmp/meta.json');
    expect(args.slice(0, 2)).toEqual(['--addr', 'tcp://127.0.0.1:5054']);
    expect(args).toContain('build');
    expect(args).toContain('dockerfile.v0');
    // Context and dockerfile both come from the appliance dir.
    expect(args).toContain('context=/work/demo/backend');
    expect(args).toContain('dockerfile=/work/demo/backend');
    expect(args).toContain('platform=linux/amd64');
    // Pushed to the runtime registry under the SAME ref pods pull,
    // over plain HTTP (the in-VM registry has no TLS).
    expect(args).toContain('type=image,name=localhost:5052/demo-backend:latest,push=true,registry.insecure=true');
    expect(args.at(-2)).toBe('--metadata-file');
    expect(args.at(-1)).toBe('/tmp/meta.json');
  });

  it('omits the platform opt when unset', () => {
    const args = buildctlArgs(opts, '/tmp/meta.json');
    expect(args.join(' ')).not.toContain('platform=');
  });
});

describe('parseBuildkitMetadata', () => {
  it('extracts the pushed image digest', () => {
    const digest = 'sha256:' + 'a'.repeat(64);
    const json = JSON.stringify({ 'containerimage.digest': digest, 'image.name': 'localhost:5052/x:latest' });
    expect(parseBuildkitMetadata(json)).toBe(digest);
  });

  it('rejects metadata without a digest — deploy-by-digest must never regress to a tag', () => {
    expect(() => parseBuildkitMetadata('{}')).toThrow(/containerimage.digest/);
    expect(() => parseBuildkitMetadata(JSON.stringify({ 'containerimage.digest': 'latest' }))).toThrow();
  });
});
