const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MARKER, prepareOwnedDirectory } = require('../server/services/ephemeral-directory');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dood-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('不清除未标记目录中的旧式缓存文件', t => {
  const directory = tempDirectory(t);
  const legacyFile = path.join(directory, '1234567890-abcdef0123456789.png');
  fs.writeFileSync(legacyFile, 'private data');
  assert.throws(() => prepareOwnedDirectory(directory), /Refusing to clear unowned directory/);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), 'private data');
  assert.equal(fs.existsSync(path.join(directory, MARKER)), false);
});

test('拒绝内容不正确的归属标记', t => {
  const directory = tempDirectory(t);
  const privateFile = path.join(directory, 'private.txt');
  fs.writeFileSync(privateFile, 'private data');
  fs.writeFileSync(path.join(directory, MARKER), 'not DooD');
  assert.throws(() => prepareOwnedDirectory(directory), /marker invalid/);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'private data');
});

test('只清除带有效标记的 DooD 临时文件', t => {
  const directory = tempDirectory(t);
  prepareOwnedDirectory(directory);
  const transientFile = path.join(directory, 'temporary.bin');
  fs.writeFileSync(transientFile, 'cache');
  prepareOwnedDirectory(directory);
  assert.equal(fs.existsSync(transientFile), false);
  assert.equal(fs.existsSync(path.join(directory, MARKER)), true);
});
