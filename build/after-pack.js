// Ad-hoc code-sign the macOS app after packaging. Apple Silicon refuses to run
// completely unsigned binaries; an ad-hoc signature ("-") is enough to launch
// once the user approves the app in Gatekeeper (no Apple Developer ID needed).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;
  // Universal builds pack per-arch temp apps first; only sign the final merged app.
  if (/-temp$/.test(context.appOutDir)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
