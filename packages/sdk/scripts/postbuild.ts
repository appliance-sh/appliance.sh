import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const updateVersion = (filePath: string, version: string): void => {
  const fileContent = readFileSync(filePath, 'utf8');
  const updatedContent = fileContent.replace(/0\.0\.0-semantically-released/g, version);
  writeFileSync(filePath, updatedContent, 'utf8');
};

/**
 * Rewrite extensionless relative imports to include `.js` (or
 * `/index.js` for directories) so Node's native ESM resolver
 * accepts them at runtime.
 *
 * tsc with `--moduleResolution bundler` preserves the author's
 * extensionless specifiers, which works inside Vite/Rollup but
 * fails with `ERR_UNSUPPORTED_DIR_IMPORT` when Node runs the
 * emitted code directly (e.g. the CLI importing `@appliance.sh/sdk`).
 */
const rewriteImportsInFile = (filePath: string): void => {
  const original = readFileSync(filePath, 'utf8');
  const baseDir = dirname(filePath);

  const rewriteSpec = (spec: string): string => {
    // Already has a module-relevant extension — leave alone.
    if (/\.(m?js|c?js|json)$/i.test(spec)) return spec;
    const resolved = resolve(baseDir, spec);
    try {
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        return `${spec}/index.js`;
      }
    } catch {
      // fall through
    }
    return `${spec}.js`;
  };

  // Covers: import … from '…', export … from '…', dynamic import('…'),
  // and side-effect `import '…'` forms. Limited to specifiers that
  // start with `./` or `../` so bare package imports are untouched.
  const patterns: RegExp[] = [
    /(\bfrom\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    /(\bimport\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"])/g,
    /(\bimport\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
  ];

  let content = original;
  for (const re of patterns) {
    content = content.replace(re, (_m, prefix: string, spec: string, suffix: string) => {
      return `${prefix}${rewriteSpec(spec)}${suffix}`;
    });
  }

  if (content !== original) writeFileSync(filePath, content, 'utf8');
};

const rewriteImportsInDir = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) rewriteImportsInDir(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) rewriteImportsInFile(full);
  }
};

const main = (): void => {
  try {
    // Get the latest Git tag
    const latestTag = execSync('git describe --tags --abbrev=0').toString().trim();

    // Define file paths to update
    const filesToUpdate = [join(__dirname, '../dist/cjs/version.js'), join(__dirname, '../dist/esm/version.js')];

    // Update version in each file
    filesToUpdate.forEach((filePath) => updateVersion(filePath, latestTag));

    console.log(`Version updated to ${latestTag} in files:`, filesToUpdate);

    // The SDK's root package.json declares "type": "commonjs". Node and
    // bundlers would otherwise treat dist/esm/*.js files as CJS because
    // of that. Drop a tiny package.json inside dist/esm that overrides
    // the type locally — tells Node (and strict bundlers) these files
    // are real ESM.
    writeFileSync(
      join(__dirname, '../dist/esm/package.json'),
      JSON.stringify({ type: 'module' }, null, 2) + '\n',
      'utf8'
    );

    // Add explicit .js / /index.js extensions to all relative imports
    // in the ESM output for native Node ESM resolution.
    rewriteImportsInDir(join(__dirname, '../dist/esm'));
  } catch (error) {
    console.error('Error updating version:', error);
    process.exit(1);
  }
};

main();
