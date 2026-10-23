// After `npm run dist`: write release/RELEASE-INFO.txt with name, size and SHA-256 of each built .exe,
// so IT can whitelist exactly this file (see ../IT-Anfrage_Electron_Quarantaene.md).
// Usage: node scripts/release-info.js [release-dir]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'release'));
const pkg = require(path.join(root, 'package.json'));
let electronVersion = '?';
try {
  electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
} catch {
  // not installed – leave '?'
}

const exes = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^Aurao.*\.exe$/i.test(f)).sort()
  : [];
if (!exes.length) {
  console.error(`Keine .exe in ${dir} gefunden.`);
  process.exit(1);
}

const isSigned = Boolean(process.env.SIGNPATH_API_TOKEN || process.env.AURAO_SIGNED === '1');
const lines = [
  `${pkg.productName || pkg.name} ${pkg.version} – Release-Informationen für die IT-Freigabe`,
  `Erstellt: ${new Date().toISOString()}`,
  `Electron: ${electronVersion} · ${isSigned ? 'Authenticode-signiert (SignPath.io)' : 'nicht signiert'}`,
  '',
];
for (const name of exes) {
  const file = path.join(dir, name);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
  lines.push(`Datei:   ${name}`, `Größe:   ${fs.statSync(file).size} Bytes`, `SHA-256: ${hash}`, '');
}
const text = lines.join('\n');
fs.writeFileSync(path.join(dir, 'RELEASE-INFO.txt'), text, 'utf8');

const wingetTemplatePath = path.join(root, 'packaging', 'winget', 'badnexus.Aurao.yaml');
if (fs.existsSync(wingetTemplatePath) && exes.length > 0) {
  const portableName = exes.find((f) => f === `Aurao-${pkg.version}.exe`) || exes[0];
  const primaryExe = path.join(dir, portableName);
  const primaryHash = crypto.createHash('sha256').update(fs.readFileSync(primaryExe)).digest('hex').toUpperCase();
  const wingetYaml = fs
    .readFileSync(wingetTemplatePath, 'utf8')
    .replace(/PackageVersion:\s*.*/, `PackageVersion: ${pkg.version}`)
    .replace(/InstallerSha256:\s*[0-9A-Fa-f]{64}/, `InstallerSha256: ${primaryHash}`);
  fs.writeFileSync(path.join(dir, 'badnexus.Aurao.yaml'), wingetYaml, 'utf8');
}

console.log(text);
