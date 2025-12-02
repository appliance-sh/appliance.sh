import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const updateVersion = (filePath: string, version: string): void => {
  const fileContent = readFileSync(filePath, 'utf8');
  const updatedContent = fileContent.replace(/0\.0\.0-semantically-released/g, version);
  writeFileSync(filePath, updatedContent, 'utf8');
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
  } catch (error) {
    console.error('Error updating version:', error);
    process.exit(1);
  }
};

main();
