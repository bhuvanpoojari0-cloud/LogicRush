'use strict';

const fs = require('fs');
const path = require('path');
const {
  FILE_MAGIC,
  FILE_VERSION,
  FILE_HEADER_SIZE,
  RECORD_MAGIC,
  RECORD_HEADER_SIZE,
  OP_PUT,
  OP_DEL,
  OP_BATCH_COMMIT,
  OP_BATCH_PUT,
  OP_BATCH_DEL,
  MAX_KEY_LEN,
  MAX_VAL_LEN,
  MAX_BATCH_SIZE,
} = require('./constants');
const { crc32, computeRecordCrc } = require('./crc32');
const { Mutex, FileLock } = require('./lock');

class KVDB {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = Number(options.maxBytes || 0);
    this.fd = null;
    this.fileSize = 0;
    this.index = new Map(); // key -> [valOffset, valLen]
    this.nextTxId = 1n;
    this.mutex = new Mutex();
    this.fileLock = new FileLock(this.filePath);
    this.isOpen = false;
  }

  static async open(filePath, options = {}) {
    const db = new KVDB(filePath, options);
    await db.open();
    return db;
  }

  async open() {
    return this.mutex.withLock(async () => {
      this._openSync();
    });
  }

  _openSync() {
    if (this.isOpen) return;

    // Clean up any leftover compaction temp files from previous crash
    const compactTmp = this.filePath + '.compact.tmp';
    if (fs.existsSync(compactTmp)) {
      try {
        fs.unlinkSync(compactTmp);
      } catch (e) {}
    }

    try {
      this.fileLock.acquireSync(2000);
    } catch (e) {}

    const fileExists = fs.existsSync(this.filePath);
    if (!fileExists) {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.fd = fs.openSync(this.filePath, 'w+');
      this._writeHeaderSync();
      this.fileSize = FILE_HEADER_SIZE;
      this.isOpen = true;
      return { keyCount: 0, recoveryTimeMs: 0 };
    }

    this.fd = fs.openSync(this.filePath, 'r+');
    const stat = fs.statSync(this.filePath);
    this.fileSize = stat.size;

    if (this.fileSize === 0) {
      this._writeHeaderSync();
      this.fileSize = FILE_HEADER_SIZE;
      this.isOpen = true;
      return { keyCount: 0, recoveryTimeMs: 0 };
    }

    const t0 = performance.now();
    this._recoverSync();
    const t1 = performance.now();
    this.isOpen = true;
    return {
      keyCount: this.getKeyCount(),
      recoveryTimeMs: Number((t1 - t0).toFixed(2)),
    };
  }

  _writeHeaderSync() {
    const header = Buffer.alloc(FILE_HEADER_SIZE);
    FILE_MAGIC.copy(header, 0);
    header.writeUInt32LE(FILE_VERSION, 8);
    header.writeUInt32LE(0, 12);
    fs.writeSync(this.fd, header, 0, FILE_HEADER_SIZE, 0);
    fs.fsyncSync(this.fd);
  }

  _recoverSync() {
    if (this.fileSize < FILE_HEADER_SIZE) {
      this._writeHeaderSync();
      this.fileSize = FILE_HEADER_SIZE;
      fs.ftruncateSync(this.fd, FILE_HEADER_SIZE);
      fs.fsyncSync(this.fd);
      return;
    }

    const headerBuf = Buffer.alloc(FILE_HEADER_SIZE);
    fs.readSync(this.fd, headerBuf, 0, FILE_HEADER_SIZE, 0);
    if (!headerBuf.subarray(0, 8).equals(FILE_MAGIC)) {
      throw new Error(`CORRUPTED: Invalid database file magic header in ${this.filePath}`);
    }

    let lastValidCommittedOffset = FILE_HEADER_SIZE;
    let maxSeenTxId = 0n;
    this.index.clear();

    const pendingBatches = new Map();
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB read buffer
    const readBuf = Buffer.alloc(CHUNK_SIZE);
    let curFilePos = FILE_HEADER_SIZE;
    let carryOver = Buffer.alloc(0);
    let carryOverFileOffset = FILE_HEADER_SIZE;

    while (curFilePos < this.fileSize) {
      const bytesToRead = Math.min(CHUNK_SIZE, this.fileSize - curFilePos);
      const bytesRead = fs.readSync(this.fd, readBuf, 0, bytesToRead, curFilePos);
      if (bytesRead <= 0) break;

      const chunkStartPos = curFilePos;
      curFilePos += bytesRead;

      let combined;
      let combinedFileStart;
      if (carryOver.length > 0) {
        combined = Buffer.concat([carryOver, readBuf.subarray(0, bytesRead)]);
        combinedFileStart = carryOverFileOffset;
      } else {
        combined = readBuf.subarray(0, bytesRead);
        combinedFileStart = chunkStartPos;
      }

      let offset = 0;
      let stopScanning = false;

      while (offset < combined.length) {
        if (offset + RECORD_HEADER_SIZE > combined.length) {
          break;
        }

        const magic = combined[offset];
        if (magic !== RECORD_MAGIC) {
          stopScanning = true;
          break;
        }

        const opType = combined[offset + 1];
        const pLen = combined.readUInt32LE(offset + 10);
        const storedCrc = combined.readUInt32LE(offset + 14);

        const totalRecLen = RECORD_HEADER_SIZE + pLen;
        if (offset + totalRecLen > combined.length) {
          if (curFilePos < this.fileSize) {
            break;
          } else {
            stopScanning = true;
            break;
          }
        }

        // Zero-allocation CRC check
        const computedCrc = computeRecordCrc(combined, offset + 1, offset + 14, offset + RECORD_HEADER_SIZE, offset + totalRecLen);

        if (computedCrc !== storedCrc) {
          stopScanning = true;
          break;
        }

        const txId = combined.readBigUInt64LE(offset + 2);
        if (txId > maxSeenTxId) maxSeenTxId = txId;

        const recFileOffset = combinedFileStart + offset;

        if (opType === OP_PUT) {
          const klen = combined.readUInt16LE(offset + RECORD_HEADER_SIZE);
          const vlen = combined.readUInt32LE(offset + RECORD_HEADER_SIZE + 2);
          const keyStart = offset + RECORD_HEADER_SIZE + 6;
          const key = combined.toString('utf8', keyStart, keyStart + klen);
          const valFileOffset = recFileOffset + RECORD_HEADER_SIZE + 6 + klen;
          this.index.set(key, [valFileOffset, vlen]);
          lastValidCommittedOffset = recFileOffset + totalRecLen;
        } else if (opType === OP_DEL) {
          const klen = combined.readUInt16LE(offset + RECORD_HEADER_SIZE);
          const keyStart = offset + RECORD_HEADER_SIZE + 6;
          const key = combined.toString('utf8', keyStart, keyStart + klen);
          this.index.delete(key);
          lastValidCommittedOffset = recFileOffset + totalRecLen;
        } else if (opType === OP_BATCH_PUT || opType === OP_BATCH_DEL) {
          const klen = combined.readUInt16LE(offset + RECORD_HEADER_SIZE);
          const vlen = combined.readUInt32LE(offset + RECORD_HEADER_SIZE + 2);
          const keyStart = offset + RECORD_HEADER_SIZE + 6;
          const key = combined.toString('utf8', keyStart, keyStart + klen);
          const valFileOffset = recFileOffset + RECORD_HEADER_SIZE + 6 + klen;

          if (!pendingBatches.has(txId)) pendingBatches.set(txId, []);
          pendingBatches.get(txId).push({
            opType,
            key,
            valOffset: valFileOffset,
            valLen: vlen,
            crc: storedCrc,
          });
        } else if (opType === OP_BATCH_COMMIT) {
          const opCount = combined.readUInt32LE(offset + RECORD_HEADER_SIZE);
          const expectedChecksum = combined.readUInt32LE(offset + RECORD_HEADER_SIZE + 4);

          const items = pendingBatches.get(txId);
          if (items && items.length === opCount) {
            let actualChecksum = 0;
            for (const item of items) {
              actualChecksum = (actualChecksum ^ item.crc) >>> 0;
            }
            if (actualChecksum === expectedChecksum) {
              for (const item of items) {
                if (item.opType === OP_BATCH_PUT) {
                  this.index.set(item.key, [item.valOffset, item.valLen]);
                } else if (item.opType === OP_BATCH_DEL) {
                  this.index.delete(item.key);
                }
              }
              pendingBatches.delete(txId);
              lastValidCommittedOffset = recFileOffset + totalRecLen;
            } else {
              stopScanning = true;
              break;
            }
          } else {
            stopScanning = true;
            break;
          }
        }

        offset += totalRecLen;
      }

      if (stopScanning) break;

      carryOver = Buffer.from(combined.subarray(offset));
      carryOverFileOffset = combinedFileStart + offset;
    }

    if (lastValidCommittedOffset < this.fileSize) {
      fs.ftruncateSync(this.fd, lastValidCommittedOffset);
      fs.fsyncSync(this.fd);
      this.fileSize = lastValidCommittedOffset;
    }

    this.nextTxId = maxSeenTxId + 1n;
  }

  // --- API Operations ---

  async put(key, value) {
    return this.mutex.withLock(async () => {
      this._assertOpen();
      const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
      const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');

      if (keyBuf.length < 1 || keyBuf.length > MAX_KEY_LEN) {
        throw new Error(`Key length must be between 1 and ${MAX_KEY_LEN} bytes`);
      }
      if (valBuf.length > MAX_VAL_LEN) {
        throw new Error(`Value length cannot exceed ${MAX_VAL_LEN} bytes`);
      }

      const txId = this.nextTxId++;
      const payloadLen = 6 + keyBuf.length + valBuf.length;
      const totalLen = RECORD_HEADER_SIZE + payloadLen;

      if (this.maxBytes > 0 && this.fileSize + totalLen > this.maxBytes) {
        throw new Error(`DISK_FULL: Maximum database file size (${this.maxBytes} bytes) exceeded`);
      }

      const recBuf = Buffer.alloc(totalLen);
      recBuf[0] = RECORD_MAGIC;
      recBuf[1] = OP_PUT;
      recBuf.writeBigUInt64LE(txId, 2);
      recBuf.writeUInt32LE(payloadLen, 10);
      recBuf.writeUInt16LE(keyBuf.length, 18);
      recBuf.writeUInt32LE(valBuf.length, 20);
      keyBuf.copy(recBuf, 24);
      valBuf.copy(recBuf, 24 + keyBuf.length);

      const check = computeRecordCrc(recBuf, 1, 14, RECORD_HEADER_SIZE, totalLen);
      recBuf.writeUInt32LE(check, 14);

      const writeOffset = this.fileSize;
      fs.writeSync(this.fd, recBuf, 0, totalLen, writeOffset);
      fs.fsyncSync(this.fd);
      this.fileSize += totalLen;

      const keyStr = keyBuf.toString('utf8');
      const valOffset = writeOffset + RECORD_HEADER_SIZE + 6 + keyBuf.length;
      this.index.set(keyStr, [valOffset, valBuf.length]);

      return true;
    });
  }

  async get(key) {
    this._assertOpen();
    const keyStr = Buffer.isBuffer(key) ? key.toString('utf8') : String(key);
    const entry = this.index.get(keyStr);
    if (!entry) return null;

    const [valOffset, valLen] = entry;
    if (valLen === 0) return Buffer.alloc(0);

    const valBuf = Buffer.alloc(valLen);
    fs.readSync(this.fd, valBuf, 0, valLen, valOffset);
    return valBuf;
  }

  async delete(key) {
    return this.mutex.withLock(async () => {
      this._assertOpen();
      const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
      if (keyBuf.length < 1 || keyBuf.length > MAX_KEY_LEN) {
        throw new Error(`Key length must be between 1 and ${MAX_KEY_LEN} bytes`);
      }

      const txId = this.nextTxId++;
      const payloadLen = 6 + keyBuf.length;
      const totalLen = RECORD_HEADER_SIZE + payloadLen;

      if (this.maxBytes > 0 && this.fileSize + totalLen > this.maxBytes) {
        throw new Error(`DISK_FULL: Maximum database file size (${this.maxBytes} bytes) exceeded`);
      }

      const recBuf = Buffer.alloc(totalLen);
      recBuf[0] = RECORD_MAGIC;
      recBuf[1] = OP_DEL;
      recBuf.writeBigUInt64LE(txId, 2);
      recBuf.writeUInt32LE(payloadLen, 10);
      recBuf.writeUInt16LE(keyBuf.length, 18);
      recBuf.writeUInt32LE(0, 20);
      keyBuf.copy(recBuf, 24);

      const check = computeRecordCrc(recBuf, 1, 14, RECORD_HEADER_SIZE, totalLen);
      recBuf.writeUInt32LE(check, 14);

      const writeOffset = this.fileSize;
      fs.writeSync(this.fd, recBuf, 0, totalLen, writeOffset);
      fs.fsyncSync(this.fd);
      this.fileSize += totalLen;

      const keyStr = keyBuf.toString('utf8');
      this.index.delete(keyStr);

      return true;
    });
  }

  async batch(operations) {
    return this.mutex.withLock(async () => {
      this._assertOpen();
      if (!Array.isArray(operations) || operations.length === 0) return true;
      if (operations.length > MAX_BATCH_SIZE) {
        throw new Error(`Batch size exceeds maximum limit of ${MAX_BATCH_SIZE}`);
      }

      let totalItemsLen = 0;
      const preparedOps = [];

      for (const op of operations) {
        const type = op.type ? op.type.toLowerCase() : (op.put ? 'put' : 'del');
        const key = op.key || op.k;
        const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');

        if (keyBuf.length < 1 || keyBuf.length > MAX_KEY_LEN) {
          throw new Error('Invalid key length in batch');
        }

        if (type === 'put' || type === 'set') {
          const val = op.value !== undefined ? op.value : op.v;
          const valBuf = Buffer.isBuffer(val) ? val : Buffer.from(String(val || ''), 'utf8');
          if (valBuf.length > MAX_VAL_LEN) {
            throw new Error(`Value in batch exceeds ${MAX_VAL_LEN} bytes`);
          }
          const pLen = 6 + keyBuf.length + valBuf.length;
          totalItemsLen += RECORD_HEADER_SIZE + pLen;
          preparedOps.push({ type: OP_BATCH_PUT, keyBuf, valBuf, pLen });
        } else if (type === 'del' || type === 'delete') {
          const pLen = 6 + keyBuf.length;
          totalItemsLen += RECORD_HEADER_SIZE + pLen;
          preparedOps.push({ type: OP_BATCH_DEL, keyBuf, valBuf: Buffer.alloc(0), pLen });
        } else {
          throw new Error(`Unknown batch operation type: ${type}`);
        }
      }

      const commitRecLen = RECORD_HEADER_SIZE + 8;
      const totalBatchLen = totalItemsLen + commitRecLen;

      if (this.maxBytes > 0 && this.fileSize + totalBatchLen > this.maxBytes) {
        throw new Error(`DISK_FULL: Maximum database file size (${this.maxBytes} bytes) exceeded for batch`);
      }

      const txId = this.nextTxId++;
      const itemsBuf = Buffer.alloc(totalItemsLen);
      let bufOffset = 0;
      let cumulativeChecksum = 0;
      const itemOffsets = [];

      for (const op of preparedOps) {
        const itemStart = bufOffset;
        const recTotal = RECORD_HEADER_SIZE + op.pLen;
        itemsBuf[itemStart] = RECORD_MAGIC;
        itemsBuf[itemStart + 1] = op.type;
        itemsBuf.writeBigUInt64LE(txId, itemStart + 2);
        itemsBuf.writeUInt32LE(op.pLen, itemStart + 10);
        itemsBuf.writeUInt16LE(op.keyBuf.length, itemStart + 18);
        itemsBuf.writeUInt32LE(op.valBuf.length, itemStart + 20);
        op.keyBuf.copy(itemsBuf, itemStart + 24);
        if (op.valBuf.length > 0) {
          op.valBuf.copy(itemsBuf, itemStart + 24 + op.keyBuf.length);
        }

        const itemCrc = computeRecordCrc(itemsBuf, itemStart + 1, itemStart + 14, itemStart + RECORD_HEADER_SIZE, itemStart + recTotal);
        itemsBuf.writeUInt32LE(itemCrc, itemStart + 14);

        cumulativeChecksum = (cumulativeChecksum ^ itemCrc) >>> 0;
        itemOffsets.push({
          type: op.type,
          keyStr: op.keyBuf.toString('utf8'),
          valOffset: this.fileSize + itemStart + RECORD_HEADER_SIZE + 6 + op.keyBuf.length,
          valLen: op.valBuf.length,
        });

        bufOffset += recTotal;
      }

      // Step 1: Write all batch items
      fs.writeSync(this.fd, itemsBuf, 0, totalItemsLen, this.fileSize);
      // Step 2: fsync items
      fs.fsyncSync(this.fd);
      this.fileSize += totalItemsLen;

      // Step 3: Write commit marker
      const commitBuf = Buffer.alloc(commitRecLen);
      commitBuf[0] = RECORD_MAGIC;
      commitBuf[1] = OP_BATCH_COMMIT;
      commitBuf.writeBigUInt64LE(txId, 2);
      commitBuf.writeUInt32LE(8, 10);
      commitBuf.writeUInt32LE(preparedOps.length, 18);
      commitBuf.writeUInt32LE(cumulativeChecksum, 22);

      const commitCrc = computeRecordCrc(commitBuf, 1, 14, RECORD_HEADER_SIZE, commitRecLen);
      commitBuf.writeUInt32LE(commitCrc, 14);

      fs.writeSync(this.fd, commitBuf, 0, commitRecLen, this.fileSize);
      // Step 4: fsync commit marker
      fs.fsyncSync(this.fd);
      this.fileSize += commitRecLen;

      // Step 5: Update in-memory index
      for (const item of itemOffsets) {
        if (item.type === OP_BATCH_PUT) {
          this.index.set(item.keyStr, [item.valOffset, item.valLen]);
        } else {
          this.index.delete(item.keyStr);
        }
      }

      return true;
    });
  }

  async compact() {
    return this.mutex.withLock(async () => {
      this._assertOpen();
      const compactTmp = this.filePath + '.compact.tmp';
      if (fs.existsSync(compactTmp)) {
        try { fs.unlinkSync(compactTmp); } catch (e) {}
      }

      const compactFd = fs.openSync(compactTmp, 'w+');
      const header = Buffer.alloc(FILE_HEADER_SIZE);
      FILE_MAGIC.copy(header, 0);
      header.writeUInt32LE(FILE_VERSION, 8);
      header.writeUInt32LE(0, 12);
      fs.writeSync(compactFd, header, 0, FILE_HEADER_SIZE, 0);

      let curCompactSize = FILE_HEADER_SIZE;
      const newOffsets = new Map();

      for (const [keyStr, [valOffset, valLen]] of this.index.entries()) {
        const keyBuf = Buffer.from(keyStr, 'utf8');
        const valBuf = Buffer.alloc(valLen);
        if (valLen > 0) {
          fs.readSync(this.fd, valBuf, 0, valLen, valOffset);
        }

        const txId = this.nextTxId++;
        const payloadLen = 6 + keyBuf.length + valBuf.length;
        const totalLen = RECORD_HEADER_SIZE + payloadLen;

        if (this.maxBytes > 0 && curCompactSize + totalLen > this.maxBytes) {
          fs.closeSync(compactFd);
          try { fs.unlinkSync(compactTmp); } catch (e) {}
          throw new Error(`DISK_FULL: Compaction aborted because size exceeds max_bytes limit`);
        }

        const recBuf = Buffer.alloc(totalLen);
        recBuf[0] = RECORD_MAGIC;
        recBuf[1] = OP_PUT;
        recBuf.writeBigUInt64LE(txId, 2);
        recBuf.writeUInt32LE(payloadLen, 10);
        recBuf.writeUInt16LE(keyBuf.length, 18);
        recBuf.writeUInt32LE(valBuf.length, 20);
        keyBuf.copy(recBuf, 24);
        if (valBuf.length > 0) {
          valBuf.copy(recBuf, 24 + keyBuf.length);
        }

        const check = crc32(recBuf.subarray(RECORD_HEADER_SIZE, totalLen), crc32(recBuf.subarray(1, 14)));
        recBuf.writeUInt32LE(check, 14);

        fs.writeSync(compactFd, recBuf, 0, totalLen, curCompactSize);
        const newValOffset = curCompactSize + RECORD_HEADER_SIZE + 6 + keyBuf.length;
        newOffsets.set(keyStr, [newValOffset, valLen]);
        curCompactSize += totalLen;
      }

      fs.fsyncSync(compactFd);
      fs.closeSync(compactFd);

      fs.closeSync(this.fd);
      fs.renameSync(compactTmp, this.filePath);

      this.fd = fs.openSync(this.filePath, 'r+');
      this.fileSize = curCompactSize;
      this.index = newOffsets;

      return { oldSize: this.fileSize, newSize: curCompactSize };
    });
  }

  async check() {
    this._assertOpen();
    if (!fs.existsSync(this.filePath)) {
      return { ok: false, reason: 'File does not exist' };
    }

    const stat = fs.statSync(this.filePath);
    if (stat.size < FILE_HEADER_SIZE) {
      return { ok: false, reason: `File smaller than header (${stat.size} < ${FILE_HEADER_SIZE})` };
    }

    const header = Buffer.alloc(FILE_HEADER_SIZE);
    fs.readSync(this.fd, header, 0, FILE_HEADER_SIZE, 0);
    if (!header.subarray(0, 8).equals(FILE_MAGIC)) {
      return { ok: false, reason: 'Invalid header magic bytes' };
    }

    let offset = FILE_HEADER_SIZE;
    const pendingBatches = new Map();

    while (offset < stat.size) {
      if (offset + RECORD_HEADER_SIZE > stat.size) {
        return { ok: false, reason: `Torn record header at offset ${offset}` };
      }

      const recHdr = Buffer.alloc(RECORD_HEADER_SIZE);
      fs.readSync(this.fd, recHdr, 0, RECORD_HEADER_SIZE, offset);

      if (recHdr[0] !== RECORD_MAGIC) {
        return { ok: false, reason: `Invalid record magic 0x${recHdr[0].toString(16)} at offset ${offset}` };
      }

      const opType = recHdr[1];
      const txId = recHdr.readBigUInt64LE(2);
      const pLen = recHdr.readUInt32LE(10);
      const storedCrc = recHdr.readUInt32LE(14);

      const totalRec = RECORD_HEADER_SIZE + pLen;
      if (offset + totalRec > stat.size) {
        return { ok: false, reason: `Torn payload: expected ${pLen} bytes at offset ${offset}` };
      }

      const pBuf = Buffer.alloc(pLen);
      fs.readSync(this.fd, pBuf, 0, pLen, offset + RECORD_HEADER_SIZE);

      const calcCrc = crc32(pBuf, crc32(recHdr.subarray(1, 14)));
      if (calcCrc !== storedCrc) {
        return { ok: false, reason: `CRC mismatch at offset ${offset}` };
      }

      if (opType === OP_BATCH_PUT || opType === OP_BATCH_DEL) {
        if (!pendingBatches.has(txId)) pendingBatches.set(txId, []);
        pendingBatches.get(txId).push(storedCrc);
      } else if (opType === OP_BATCH_COMMIT) {
        const count = pBuf.readUInt32LE(0);
        const checksum = pBuf.readUInt32LE(4);
        const items = pendingBatches.get(txId);
        if (!items || items.length !== count) {
          return { ok: false, reason: `Batch commit mismatch: expected count ${count}` };
        }
        let actCrc = 0;
        for (const c of items) actCrc = (actCrc ^ c) >>> 0;
        if (actCrc !== checksum) {
          return { ok: false, reason: `Batch commit checksum mismatch at offset ${offset}` };
        }
        pendingBatches.delete(txId);
      }

      offset += totalRec;
    }

    if (pendingBatches.size > 0) {
      return { ok: false, reason: `Uncommitted batch transactions remaining on disk` };
    }

    return { ok: true, reason: 'OK' };
  }

  async dump() {
    this._assertOpen();
    const sortedKeys = Array.from(this.index.keys()).sort();
    const result = [];

    for (const key of sortedKeys) {
      const entry = this.index.get(key);
      if (entry) {
        const [valOffset, valLen] = entry;
        const valBuf = Buffer.alloc(valLen);
        if (valLen > 0) {
          fs.readSync(this.fd, valBuf, 0, valLen, valOffset);
        }
        result.push({ key, value: valBuf.toString('utf8') });
      }
    }
    return result;
  }

  getKeyCount() {
    return this.index.size;
  }

  close() {
    if (!this.isOpen) return;
    this.mutex.acquireSync();
    try {
      if (this.fd !== null) {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.fd = null;
      }
      this.fileLock.releaseSync();
      this.isOpen = false;
    } finally {
      this.mutex.releaseSync();
    }
  }

  _assertOpen() {
    if (!this.isOpen || this.fd === null) {
      throw new Error(`Database is not open: ${this.filePath}`);
    }
  }
}

module.exports = {
  KVDB,
};
