// electron-builder afterSign: sign the app with a stable identity, so macOS keeps its
// permissions (Local Network) across rebuilds. Ad-hoc signing ties them to one build's hash.
// Uses DEVDOCK_SIGN_IDENTITY or a "DevDock Local Signing" certificate; without one, keeps ad-hoc.
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

exports.default = async ({ appOutDir, packager, electronPlatformName }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  // signed (and notarized) with a Developer ID already: re-signing would undo both
  const info = spawnSync('/usr/bin/codesign', ['-dvv', app], { encoding: 'utf8' }).stderr || '';
  if (info.includes('Authority=Developer ID Application')) return console.log('  • Developer ID signed: keeping it');
  const name = process.env.DEVDOCK_SIGN_IDENTITY || 'DevDock Local Signing';
  const found = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning']).toString().split('\n').find(l => l.includes(`"${name}"`));
  if (!found) return console.log(`  • no "${name}" certificate: the app stays ad-hoc signed`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', found.trim().split(/\s+/)[1], app], { stdio: 'inherit' });
  console.log(`  • signed with "${name}"`);
};
