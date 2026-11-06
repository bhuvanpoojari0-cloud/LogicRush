'use strict';

// Fixed File Header (16 bytes)
// [MAGIC (8B)][VERSION (4B)][FLAGS/RESERVED (4B)]
const FILE_MAGIC = Buffer.from('KVDB001\0', 'binary'); // 8 bytes
const FILE_VERSION = 1;
const FILE_HEADER_SIZE = 16;

// Record Framing Prefix (18 bytes)
// [MAGIC (1B)][TYPE (1B)][TX_ID (8B)][LENGTH (4B)][CRC32 (4B)]
const RECORD_MAGIC = 0xAA;
const RECORD_HEADER_SIZE = 18;

// Record Operation Types
const OP_PUT = 0x01;          // Committed single PUT
const OP_DEL = 0x02;          // Committed single DELETE
const OP_BATCH_COMMIT = 0x04; // Sealing marker for a batch transaction
const OP_BATCH_PUT = 0x05;    // Item in an uncommitted batch
const OP_BATCH_DEL = 0x06;    // Item in an uncommitted batch

// System Limits
const MAX_KEY_LEN = 1024;               // Up to 1 KB
const MAX_VAL_LEN = 1024 * 1024;        // Up to 1 MB
const MAX_BATCH_SIZE = 10000;           // Up to 10,000 ops per batch
const DEFAULT_MAX_BYTES = 0;            // 0 means no limit unless specified

module.exports = {
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
  DEFAULT_MAX_BYTES,
};

