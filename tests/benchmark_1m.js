'use strict';

const fs = require('fs');
const path = require('path');
const { KVDB } = require('../src/engine');

const BENCH_DB = path.resolve('bench_1m.db');

async function benchmark() {
  console.log('====================================================');
  console.log(' 1,000,000 KEYS RECOVERY BENCHMARK (Scenario F3)');
  console.log('====================================================');

  try { if (fs.existsSync(BENCH_DB)) fs.unlinkSync(BENCH_DB); } catch (e) {}

  const N = 1000000;
  console.log(`Populating ${N.toLocaleString()} keys directly to disk...`);
  const fd = fs.openSync(BENCH_DB, 'w+');

  // Header (16 bytes)
  const header = Buffer.alloc(16);
  header.write('KVDB001\0', 0, 8, 'binary');
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(0, 12);
  fs.writeSync(fd, header, 0, 16, 0);

  // Write in 256 KB buffers for high speed file creation
  const BUFFER_SIZE = 256 * 1024;
  const chunk = Buffer.alloc(BUFFER_SIZE);
  let chunkOffset = 0;
  let fileOffset = 16;

  // Pre-calculate dummy CRC and format
  // Record: magic(1B) + type(1B) + txId(8B) + pLen(4B) + crc(4B) + klen(2B) + vlen(4B) + key(8B) + val(8B) = 40B
  const pLen = 22; // 6 + 8 + 8
  const recLen = 18 + pLen; // 40 bytes

  for (let i = 0; i < N; i++) {
    if (chunkOffset + recLen > BUFFER_SIZE) {
      fs.writeSync(fd, chunk, 0, chunkOffset, fileOffset);
      fileOffset += chunkOffset;
      chunkOffset = 0;
    }

    const start = chunkOffset;
    chunk[start] = 0xAA;
    chunk[start + 1] = 0x01; // OP_PUT
    chunk.writeBigUInt64LE(BigInt(i + 1), start + 2);
    chunk.writeUInt32LE(pLen, start + 10);
    // Dummy CRC for benchmark write (or valid CRC)
    chunk.writeUInt16LE(8, start + 18);
    chunk.writeUInt32LE(8, start + 20);
    chunk.write('k' + String(i).padStart(7, '0'), start + 24, 8, 'latin1');
    chunk.write('v' + String(i).padStart(7, '0'), start + 32, 8, 'latin1');

    // Fast CRC calculation
    const crcData = Buffer.concat([
      chunk.subarray(start + 1, start + 14),
      chunk.subarray(start + 18, start + recLen),
    ]);
    const { crc32 } = require('../src/crc32');
    const c = crc32(crcData);
    chunk.writeUInt32LE(c, start + 14);

    chunkOffset += recLen;
  }

  if (chunkOffset > 0) {
    fs.writeSync(fd, chunk, 0, chunkOffset, fileOffset);
    fileOffset += chunkOffset;
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  const stat = fs.statSync(BENCH_DB);
  console.log(`File created: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  console.log('Now opening database and measuring recovery time...');
  const t0 = performance.now();
  const db = await KVDB.open(BENCH_DB);
  const t1 = performance.now();
  const durationMs = t1 - t0;
  const keyCount = db.getKeyCount();
  db.close();

  console.log(`Recovery Time: ${durationMs.toFixed(2)} ms (${(durationMs / 1000).toFixed(2)} s)`);
  console.log(`Keys Recovered: ${keyCount.toLocaleString()}`);

  if (durationMs < 2000) {
    console.log('\n>>> SUCCESS: Recovery completed under 2.0 seconds! Scenario F3 SATISFIED! <<<\n');
  } else {
    console.error('\n>>> FAILURE: Recovery exceeded 2.0 seconds! <<<\n');
    process.exit(1);
  }

  try { if (fs.existsSync(BENCH_DB)) fs.unlinkSync(BENCH_DB); } catch (e) {}
}

benchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
