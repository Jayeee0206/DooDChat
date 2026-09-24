function decodeBase64Image(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('图片数据为空');
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error('图片过大');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Base64 数据无效');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) throw new Error('图片大小无效');
  return buffer;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sof.has(marker) && length >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function detectImage(buffer) {
  if (buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { ext: 'png', mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.length >= 10) {
    const signature = buffer.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { ext: 'gif', mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
  }

  const jpeg = jpegDimensions(buffer);
  if (jpeg) return { ext: 'jpg', mime: 'image/jpeg', ...jpeg };

  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        ext: 'webp',
        mime: 'image/webp',
        width: readUInt24LE(buffer, 24) + 1,
        height: readUInt24LE(buffer, 27) + 1,
      };
    }
    if (chunk === 'VP8L' && buffer[20] === 0x2f && buffer.length >= 25) {
      const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
      return {
        ext: 'webp',
        mime: 'image/webp',
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        ext: 'webp',
        mime: 'image/webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }

  return null;
}

function validateImage(buffer, { maxPixels, maxDimension }) {
  const info = detectImage(buffer);
  if (!info) throw new Error('不支持或损坏的图片');
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1) {
    throw new Error('图片尺寸无效');
  }
  if (info.width > maxDimension || info.height > maxDimension || info.width * info.height > maxPixels) {
    throw new Error('图片尺寸过大');
  }
  return info;
}

module.exports = { decodeBase64Image, detectImage, validateImage };
