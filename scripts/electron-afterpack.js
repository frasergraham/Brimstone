// electron-builder afterPack hook — strips macOS extended attributes
// (resource forks, Finder metadata) that cause codesign to fail.
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export default async function (context) {
  if (process.platform !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • stripping extended attributes from ${appPath}`);
  execSync(`xattr -cr "${appPath}"`);
}
