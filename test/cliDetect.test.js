const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectInstalledEngines, resolveFirstRunEngine } = require('../dist/main/cliDetect.js');

function createFakeExecutable(dir, filename, platform) {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, '#!/bin/sh\necho ok\n', 'utf8');
  if (platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

test('detectInstalledEngines: recommends gpts when only codex is installed on PATH', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-clidetect-'));
  try {
    createFakeExecutable(tmpDir, 'codex.cmd', 'win32');
    const detected = detectInstalledEngines({
      envPath: tmpDir,
      platform: 'win32',
      homeDir: '',
      appDataDir: '',
      localAppDataDir: '',
    });
    assert.strictEqual(detected.claude, false);
    assert.strictEqual(detected.gpts, true);
    assert.strictEqual(detected.agy, false);
    assert.strictEqual(detected.recommended, 'gpts');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectInstalledEngines: recommends agy when only agy is installed on POSIX PATH', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-clidetect-'));
  try {
    createFakeExecutable(tmpDir, 'agy', 'linux');
    const detected = detectInstalledEngines({
      envPath: tmpDir,
      platform: 'linux',
      homeDir: '',
      appDataDir: '',
      localAppDataDir: '',
    });
    assert.strictEqual(detected.claude, false);
    assert.strictEqual(detected.gpts, false);
    assert.strictEqual(detected.agy, true);
    assert.strictEqual(detected.recommended, 'agy');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectInstalledEngines: falls back to claude when no external CLI is found', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-clidetect-empty-'));
  try {
    const detected = detectInstalledEngines({
      envPath: tmpDir,
      platform: 'win32',
      homeDir: '',
      appDataDir: '',
      localAppDataDir: '',
    });
    assert.strictEqual(detected.claude, false);
    assert.strictEqual(detected.gpts, false);
    assert.strictEqual(detected.agy, false);
    assert.strictEqual(detected.recommended, 'claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFirstRunEngine: preserves bundledEngine if installed, otherwise switches to installed CLI', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-clidetect-firstrun-'));
  try {
    createFakeExecutable(tmpDir, 'codex.exe', 'win32');
    const opts = {
      envPath: tmpDir,
      platform: 'win32',
      homeDir: '',
      appDataDir: '',
      localAppDataDir: '',
    };
    // Bundled says 'agy', but only 'codex' is installed -> should auto-switch to 'gpts'
    assert.strictEqual(resolveFirstRunEngine('agy', opts), 'gpts');

    // Now also install 'agy.cmd' -> bundled 'agy' is installed so it is preserved
    createFakeExecutable(tmpDir, 'agy.cmd', 'win32');
    assert.strictEqual(resolveFirstRunEngine('agy', opts), 'agy');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
