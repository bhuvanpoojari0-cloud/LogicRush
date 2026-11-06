'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { KVDB } = require('../src/engine');
const { crc32 } = require('../src/crc32');

const TEST_DB = path.resolve('unit_test.db');

function cleanup() {
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch (e) {}
  try { if (fs.existsSync(TEST_DB + '.lock')) fs.unlinkSync(TEST_DB + '.lock'); } catch (e) {}
  try { if (fs.existsSync(TEST_DB + '.compact.tmp')) fs.unlinkSync(TEST_DB + '.compact.tmp'); } catch (e) {}
}

async function runTests() {
  console.log('Running KVDB Comprehensive Unit Tests...');
  cleanup();

  // Test 1: Basic PUT and GET
  console.log('1. Testing PUT and GET...');
  let db = await KVDB.open(TEST_DB);
  await db.put('user:1', 'Alice');
  await db.put('user:2', 'Bob');
  let val1 = await db.get('user:1');
  let val2 = await db.get('user:2');
  assert.strictEqual(val1.toString('utf8'), 'Alice');
  assert.strictEqual(val2.toString('utf8'), 'Bob');
  db.close();

  // Test 2: Reopen and verify persistence (A5)
  console.log('2. Testing Persistence on Reopen (A5)...');
  db = await KVDB.open(TEST_DB);
  val1 = await db.get('user:1');
  assert.strictEqual(val1.toString('utf8'), 'Alice');
  assert.strictEqual(db.getKeyCount(), 2);
  db.close();

  // Test 3: DELETE and Missing Key (A6)
  console.log('3. Testing DELETE and Missing Key...');
  db = await KVDB.open(TEST_DB);
  await db.delete('user:1');
  assert.strictEqual(await db.get('user:1'), null);
  // Deleting missing key is not an error
  await db.delete('nonexistent');
  assert.strictEqual(await db.get('nonexistent'), null);
  assert.strictEqual(db.getKeyCount(), 1);
  db.close();

  // Test 4: Atomic Batch (B4 & B5)
  console.log('4. Testing Atomic Batch & B5 Ordering...');
  db = await KVDB.open(TEST_DB);
  // B5: Batch that puts key X and deletes key X in the same batch
  await db.batch([
    { type: 'put', key: 'alpha', value: '1' },
    { type: 'put', key: 'beta', value: '2' },
    { type: 'put', key: 'gamma', value: 'original' },
    { type: 'del', key: 'gamma' },
  ]);
  assert.strictEqual((await db.get('alpha')).toString('utf8'), '1');
  assert.strictEqual((await db.get('beta')).toString('utf8'), '2');
  assert.strictEqual(await db.get('gamma'), null); // B5 honoured!
  db.close();

  // Test 5: Uncommitted Batch Rollback (B1, B2)
  console.log('5. Testing Uncommitted Batch Rollback (B1, B2)...');
  // Append raw batch items without commit marker to simulate kill before commit
  const rawFd = fs.openSync(TEST_DB, 'r+');
  const stat = fs.statSync(TEST_DB);
  const orphanBuf = Buffer.alloc(50);
  orphanBuf[0] = 0xAA;
  orphanBuf[1] = 0x05; // OP_BATCH_PUT
  orphanBuf.writeBigUInt64LE(999999n, 2);
  orphanBuf.writeUInt32LE(20, 10);
  orphanBuf.writeUInt32LE(12345, 14); // Dummy CRC
  orphanBuf.write('dummy orphan payload', 18, 'utf8');
  fs.writeSync(rawFd, orphanBuf, 0, 50, stat.size);
  fs.fsyncSync(rawFd);
  fs.closeSync(rawFd);

  // Recovery should detect missing commit / torn record and truncate back!
  db = await KVDB.open(TEST_DB);
  const checkRes = await db.check();
  assert.strictEqual(checkRes.ok, true);
  assert.strictEqual(await db.get('dummy'), null);
  db.close();

  // Test 6: Torn tail 1-byte truncation (F4)
  console.log('6. Testing 1-byte Hand Truncation (F4)...');
  // Append 1 byte to the file
  const f4Fd = fs.openSync(TEST_DB, 'r+');
  const f4Stat = fs.statSync(TEST_DB);
  fs.writeSync(f4Fd, Buffer.from([0xAA]), 0, 1, f4Stat.size);
  fs.fsyncSync(f4Fd);
  fs.closeSync(f4Fd);

  // open() must succeed and repair the file cleanly
  db = await KVDB.open(TEST_DB);
  assert.strictEqual((await db.get('alpha')).toString('utf8'), '1');
  const f4Check = await db.check();
  assert.strictEqual(f4Check.ok, true);
  db.close();

  // Test 7: Disk-Full Cap (E1, E2)
  console.log('7. Testing Disk-Full Behavior (E1, E2)...');
  const curSize = fs.statSync(TEST_DB).size;
  // Open with maxBytes equal to current size + 10 bytes (not enough for a full record)
  db = await KVDB.open(TEST_DB, { maxBytes: curSize + 10 });
  let errorCaught = false;
  try {
    await db.put('overflow_key', 'overflow_value');
  } catch (err) {
    errorCaught = true;
    assert(err.message.includes('DISK_FULL'), 'Expected DISK_FULL error');
  }
  assert.strictEqual(errorCaught, true);
  // Database must remain fully readable and intact
  assert.strictEqual((await db.get('alpha')).toString('utf8'), '1');
  db.close();

  // Test 8: Compaction Shrinking File (E5)
  console.log('8. Testing Compaction Shrinking (E5)...');
  db = await KVDB.open(TEST_DB);
  // Put large temporary data and then delete it
  for (let i = 0; i < 100; i++) {
    await db.put(`temp:${i}`, 'X'.repeat(1000));
  }
  const bigSize = fs.statSync(TEST_DB).size;
  for (let i = 0; i < 100; i++) {
    await db.delete(`temp:${i}`);
  }
  const beforeCompactSize = fs.statSync(TEST_DB).size;
  assert(beforeCompactSize >= bigSize);

  // Compact
  await db.compact();
  const afterCompactSize = fs.statSync(TEST_DB).size;
  assert(afterCompactSize < beforeCompactSize / 2, 'File did not shrink after compaction!');
  assert.strictEqual((await db.get('alpha')).toString('utf8'), '1');
  db.close();

  cleanup();
  console.log('All Unit Tests Passed Successfully!\n');
}

runTests().catch((err) => {
  console.error('Unit tests failed:', err);
  process.exit(1);
});
