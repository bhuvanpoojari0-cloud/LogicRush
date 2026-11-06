'use strict';

const zlib = require('zlib');

// Canonical IEEE 802.3 CRC32 Lookup Table
const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buffer, previous = 0) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buffer, previous) >>> 0;
  }
  let c = (previous ^ -1);
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

// Zero-allocation CRC across two slice regions in a single Buffer
function computeRecordCrc(buf, s1, e1, s2, e2) {
  let c = -1;
  for (let i = s1; i < e1; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  for (let i = s2; i < e2; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

module.exports = {
  crc32,
  computeRecordCrc,
};
