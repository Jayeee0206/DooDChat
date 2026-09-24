const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { decodeBase64Image, validateImage } = require('./image');
const { MARKER, clearOwnedDirectory, prepareOwnedDirectory } = require('./ephemeral-directory');
const { IMAGE_PATH_RE } = require('../protocol');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req, maxBytes = config.uploadBodyMaxBytes) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      reject(new HttpError(415, 'Content-Type must be application/json'));
      return;
    }

    const chunks = [];
    let total = 0;
    let finished = false;
    const fail = error => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (finished) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new HttpError(413, 'Payload too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('aborted', () => fail(new HttpError(400, 'Request aborted')));
    req.on('error', () => fail(new HttpError(400, 'Request failed')));
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
  });
}

class UploadStore {
  constructor(directory) {
    this.directory = directory;
    this.writeQueue = Promise.resolve();
    prepareOwnedDirectory(directory);
  }

  async clear() {
    const task = this.writeQueue.then(() => clearOwnedDirectory(this.directory));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async currentBytes() {
    let total = 0;
    const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === '.gitkeep' || entry.name === MARKER) continue;
      try { total += (await fs.promises.stat(path.join(this.directory, entry.name))).size; } catch {}
    }
    return total;
  }

  // 撤回图片消息时按受信 URL 删除单个临时文件。
  // URL 必须先通过 IMAGE_PATH_RE 白名单，杜绝路径穿越；文件不存在/占用时返回 false 而不是抛错，
  // 撤回广播不受影响，残留文件仍由房间结束的统一清理兜底。
  async deleteByUrl(url) {
    if (typeof url !== 'string' || !IMAGE_PATH_RE.test(url)) return false;
    const filename = url.slice('/uploads/'.length);
    const target = path.join(this.directory, filename);
    const task = this.writeQueue.then(() => fs.promises
      .unlink(target)
      .then(() => true, () => false));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  saveBase64(data) {
    const task = this.writeQueue.then(() => this.saveBase64Now(data));
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async saveBase64Now(data) {
    let buffer;
    try {
      buffer = decodeBase64Image(data, config.uploadFileMaxBytes);
    } catch (error) {
      throw new HttpError(error.message.includes('过大') ? 413 : 400, error.message);
    }

    let info;
    try {
      info = validateImage(buffer, {
        maxPixels: config.uploadMaxPixels,
        maxDimension: config.uploadMaxDimension,
      });
    } catch (error) {
      throw new HttpError(400, error.message);
    }

    const used = await this.currentBytes();
    if (used + buffer.length > config.uploadStorageMaxBytes) {
      throw new HttpError(507, 'Upload storage quota exceeded');
    }

    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${info.ext}`;
    const destination = path.join(this.directory, filename);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    try {
      await fs.promises.rename(temporary, destination);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
    return { url: `/uploads/${filename}`, width: info.width, height: info.height, size: buffer.length };
  }
}

module.exports = { HttpError, UploadStore, readJsonBody };
