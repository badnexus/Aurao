const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listDir } = require('../dist/main/files.js');

test('listDir: hides dotfiles, dotfolders, and Windows system junctions by default (showHidden = false)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-files-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'Documents'));
    fs.mkdirSync(path.join(tmpDir, '.config'));
    fs.mkdirSync(path.join(tmpDir, 'AppData'));
    fs.mkdirSync(path.join(tmpDir, 'Local Settings'));
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(tmpDir, 'NTUSER.DAT'), 'reg');
    fs.writeFileSync(path.join(tmpDir, 'Documents', 'report.pdf'), 'pdf');
    fs.writeFileSync(path.join(tmpDir, 'Documents', '.DS_Store'), 'ds');

    const resDefault = listDir(tmpDir);
    const namesDefault = resDefault.entries.map((e) => e.name);
    assert.deepStrictEqual(namesDefault, ['Documents', 'notes.txt']);

    const docsEntryDefault = resDefault.entries.find((e) => e.name === 'Documents');
    assert.strictEqual(docsEntryDefault.size, 1, 'Hidden child files inside subfolder should not be counted when showHidden=false');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('listDir: includes dotfiles and Windows system folders when showHidden = true (except hard-excluded .git/node_modules)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-files-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'Documents'));
    fs.mkdirSync(path.join(tmpDir, '.config'));
    fs.mkdirSync(path.join(tmpDir, 'AppData'));
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(tmpDir, 'NTUSER.DAT'), 'reg');
    fs.writeFileSync(path.join(tmpDir, 'Documents', 'report.pdf'), 'pdf');
    fs.writeFileSync(path.join(tmpDir, 'Documents', '.DS_Store'), 'ds');

    const resShown = listDir(tmpDir, true);
    const namesShown = resShown.entries.map((e) => e.name);
    assert.ok(namesShown.includes('.config'), '.config should be included when showHidden=true');
    assert.ok(namesShown.includes('AppData'), 'AppData should be included when showHidden=true');
    assert.ok(namesShown.includes('.env'), '.env should be included when showHidden=true');
    assert.ok(namesShown.includes('NTUSER.DAT'), 'NTUSER.DAT should be included when showHidden=true');
    assert.ok(!namesShown.includes('.git'), '.git remains excluded in HIDE set');

    const docsEntryShown = resShown.entries.find((e) => e.name === 'Documents');
    assert.strictEqual(docsEntryShown.size, 2, 'Hidden child files inside subfolder should be counted when showHidden=true');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
