import { describe, it, expect } from 'vitest';
import { detectUpgradeChannel, upgradeInstructions } from './upgrade-channel';

describe('detectUpgradeChannel', () => {
  it('classifies the desktop-bundled sidecar (macOS .app bundle)', () => {
    expect(detectUpgradeChannel('/Applications/Appliance.app/Contents/Resources/binaries/appliance')).toBe('desktop');
    expect(detectUpgradeChannel('/Applications/Appliance.app/Contents/MacOS/appliance')).toBe('desktop');
  });

  it('classifies the desktop install dir on Windows', () => {
    expect(detectUpgradeChannel('C:\\Users\\me\\AppData\\Local\\Appliance\\appliance.exe')).toBe('desktop');
  });

  it('classifies interpreter-run source as source', () => {
    expect(detectUpgradeChannel('/usr/local/bin/node')).toBe('source');
    expect(detectUpgradeChannel('/opt/homebrew/bin/bun')).toBe('source');
    expect(detectUpgradeChannel('C:\\Program Files\\nodejs\\node.exe')).toBe('source');
  });

  it('classifies everything else as a standalone binary', () => {
    expect(detectUpgradeChannel('/usr/local/bin/appliance')).toBe('standalone');
    expect(detectUpgradeChannel('/Users/me/project/node_modules/@appliance.sh/cli/dist/appliance')).toBe('standalone');
  });
});

describe('upgradeInstructions', () => {
  it('prints instructions (not commands to run) for every channel', () => {
    for (const channel of ['desktop', 'source', 'standalone'] as const) {
      const lines = upgradeInstructions(channel);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain('undefined');
    }
    // The desktop channel points at the app updater, not npm.
    expect(upgradeInstructions('desktop').join('\n')).toContain('desktop app');
  });
});
