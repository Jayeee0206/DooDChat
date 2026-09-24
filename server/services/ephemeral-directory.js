const fs = require('fs');
const path = require('path');

const MARKER = '.dood-ephemeral-storage';
const MARKER_CONTENT = 'DooD ephemeral storage\n';
const PRESERVED = new Set([MARKER, '.gitkeep']);

function assertOwnedDirectorySync(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Not a regular directory: ${directory}`);
  const markerPath = path.join(directory, MARKER);
  if (!fs.lstatSync(markerPath).isFile() || fs.readFileSync(markerPath, 'utf8') !== MARKER_CONTENT) {
    throw new Error(`Ephemeral storage marker invalid: ${directory}`);
  }
}

function prepareOwnedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Not a regular directory: ${directory}`);
  const entries = fs.readdirSync(directory);
  const markerPath = path.join(directory, MARKER);
  if (!entries.includes(MARKER)) {
    const unknown = entries.filter(name => name !== '.gitkeep');
    if (unknown.length > 0) {
      throw new Error(`Refusing to clear unowned directory: ${directory}`);
    }
    fs.writeFileSync(markerPath, MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
  }
  clearOwnedDirectorySync(directory);
}

function clearOwnedDirectorySync(directory) {
  assertOwnedDirectorySync(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (PRESERVED.has(entry.name)) continue;
    fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function clearOwnedDirectory(directory) {
  const markerPath = path.join(directory, MARKER);
  try {
    const [directoryStat, markerStat, markerContent] = await Promise.all([
      fs.promises.lstat(directory),
      fs.promises.lstat(markerPath),
      fs.promises.readFile(markerPath, 'utf8'),
    ]);
    if (!directoryStat.isDirectory() || !markerStat.isFile() || markerContent !== MARKER_CONTENT) {
      throw new Error('Invalid ownership marker');
    }
  } catch {
    throw new Error(`Ephemeral storage marker invalid: ${directory}`);
  }
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => !PRESERVED.has(entry.name))
    .map(entry => fs.promises.rm(path.join(directory, entry.name), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })));
}

module.exports = {
  MARKER,
  clearOwnedDirectory,
  clearOwnedDirectorySync,
  prepareOwnedDirectory,
};
