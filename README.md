# KVDB: Crash-Safe Key-Value Database Engine

> **Kill It and Prove It** — 24-Hour Engineering Hackathon
> Team: **Srinathon**

KVDB is an embedded, crash-safe, single-process key-value database built from scratch with **zero database or persistence libraries**. Its primary engineering objective is **uncompromising correctness under violent, unexpected process crashes** (`kill -9`, Windows `TerminateProcess`).

Every acknowledged write survives process death; every batch is strictly atomic (all-or-nothing); no garbage or torn values are ever returned; and `open()` completes recovery of 1,000,000 keys in **under 2 seconds**.

---

## 1. Quick Start & Build

KVDB is implemented in Node.js (v18+) using exclusively the native standard library (`fs`, `path`, `crypto`, `os`, `child_process`). It runs completely offline with zero npm dependencies.

### One-Command Build / Verification
```bash
# On Linux / macOS:
chmod +x ./kvdb ./torture.sh tests/*.js
node tests/unit.test.js

# On Windows (PowerShell / Command Prompt):
node tests/unit.test.js
```

Both `./kvdb` (POSIX shell script) and `kvdb.cmd` (Windows script) are executable from the repository root. You can also run `node src/cli.js <command>`.

---

## 2. CLI Usage (All 8 Mandatory Commands)

### 1. `open`
Opens or creates the database file, executes crash recovery, repairs torn tails if present, and prints the live key count.
```bash
./kvdb open mydb.db [--max-bytes 50000000]
```
*Output*: `Keys: 42`

### 2. `put`
Persists a key-value pair to disk with immediate `fsync`.
```bash
./kvdb put mydb.db user:1 Alice
```

### 3. `get`
Retrieves the stored value for a key. Prints `NOTFOUND` if missing or deleted.
```bash
./kvdb get mydb.db user:1
```
*Output*: `Alice` (or `NOTFOUND`)

### 4. `del`
Removes a key by appending a durable tombstone record. Deleting a nonexistent key is not an error.
```bash
./kvdb del mydb.db user:1
```

### 5. `batch`
Applies a list of `put` and `del` operations atomically from a file. Either all operations commit or none.
```bash
./kvdb batch mydb.db batch_ops.txt
```
*Format of batch file (`batch_ops.txt`)*:
```
put user:100 Bob
put user:101 Charlie
del user:1
```

### 6. `dump`
Prints all active keys and values, sorted alphabetically by key.
```bash
./kvdb dump mydb.db
```
*Output*:
```
user:100 Bob
user:101 Charlie
```

### 7. `check`
Performs an offline byte-by-byte integrity verification of the database file. Checks magic headers, record framing, IEEE 802.3 CRC32 checksums, and seals on batch transactions.
```bash
./kvdb check mydb.db
```
*Output*: `OK` (or an explanatory corruption message with byte offset)

### 8. `serve`
Interactive server mode that reads operations from `stdin` and writes `ACK <op-id>` to `stdout` **only after the operation is safely persisted to disk via `fsync`**.
```bash
./kvdb serve mydb.db [--max-bytes 50000000]
```
*Stdin commands*:
- `put <op-id> <key> <value>` $\rightarrow$ outputs `ACK <op-id>`
- `del <op-id> <key>` $\rightarrow$ outputs `ACK <op-id>`
- `batch <op-id> <count>` followed by `<count>` lines of `put k v` / `del k` $\rightarrow$ outputs `ACK <op-id>`
- `batch <op-id> file <path>` $\rightarrow$ outputs `ACK <op-id>`
- `compact [op-id]` $\rightarrow$ runs compaction and outputs `ACK [op-id]`

---

## 3. On-Disk File Format

KVDB maintains authoritative state in **exactly one file**. The file consists of a 16-byte fixed header followed by self-delimited binary records. All multi-byte integers use **Little-Endian** byte order.

```
====================================================================================================
                                      KVDB ON-DISK FILE LAYOUT
====================================================================================================

+--------------------------------------------------------------------------------------------------+
| FILE HEADER (Fixed 16 Bytes at Offset 0)                                                         |
| Magic (8B): "KVDB001\0"  | Version (4B): 0x00000001 | Reserved (4B): 0x00000000                  |
+--------------------------------------------------------------------------------------------------+
| RECORD #1 (Single PUT / DELETE)                                                                  |
| Magic (1B): 0xAA                                                                                 |
| Type  (1B): 0x01 (PUT) or 0x02 (DEL)                                                             |
| TxId  (8B): uint64 Monotonically increasing Transaction ID                                       |
| PLen  (4B): uint32 Payload Length (6 + KeyLen + ValLen)                                          |
| CRC32 (4B): uint32 IEEE 802.3 Checksum over [Type + TxId + PLen + Payload]                       |
| KeyLen(2B): uint16 Length of Key (1 to 1,024 bytes)                                              |
| ValLen(4B): uint32 Length of Value (0 to 1,048,576 bytes; 0 for DEL)                              |
| Key   (KeyLen Bytes): Raw UTF-8 key bytes                                                        |
| Value (ValLen Bytes): Raw value bytes                                                            |
+--------------------------------------------------------------------------------------------------+
| RECORD #2 (Atomic Batch Item 1 of N)                                                             |
| Magic (1B): 0xAA | Type (1B): 0x05 (BATCH_PUT) | TxId (8B): Batch ID | PLen (4B) | CRC32 (4B)   |
| KeyLen(2B) | ValLen(4B) | Key bytes | Value bytes                                                |
+--------------------------------------------------------------------------------------------------+
| ... [More Batch Items sharing same TxId] ...                                                     |
+--------------------------------------------------------------------------------------------------+
| RECORD #K (Atomic Batch Commit Marker)                                                           |
| Magic (1B): 0xAA | Type (1B): 0x04 (BATCH_COMMIT) | TxId (8B): Batch ID | PLen (4B): 0x00000008 |
| CRC32 (4B): uint32 Checksum over [Type + TxId + PLen + Payload]                                  |
| OpCount       (4B): uint32 Number of items in this batch transaction                             |
| BatchChecksum (4B): uint32 Cumulative XOR checksum of all batch item CRCs                       |
+--------------------------------------------------------------------------------------------------+
```

### Accurate Byte Sizing Guide
- **File Header**: 16 bytes.
- **Record Framing Header**: 18 bytes (`1 + 1 + 8 + 4 + 4`).
- **Single PUT Record Size**: `18 + 6 + KeyLen + ValLen = 24 + KeyLen + ValLen` bytes.
- **Single DEL Record Size**: `18 + 6 + KeyLen = 24 + KeyLen` bytes.
- **BATCH_COMMIT Record Size**: `18 + 8 = 26` bytes.

---

## 4. Recovery Algorithm (Plain English)

Whenever `open(path)` is called, the database performs the following deterministic crash recovery sequence:

1. **Compaction Crash Cleanup**: Inspects the folder for any leftover `.compact.tmp` files from a prior interrupted compaction. If found, deletes them. The authoritative database file is opened in `r+` synchronous mode.
2. **Header Validation**: If the file is 0 bytes, writes the 16-byte magic header and flushes. If size $\ge 16$, reads and verifies the `"KVDB001\0"` magic bytes and version 1.
3. **Sequential Scan**: Streams the log file in 8 MB chunks into a reusable memory buffer:
   - For each candidate record, checks the `0xAA` magic byte and validates the full record length against the file boundary.
   - Computes the IEEE 802.3 CRC32 checksum across the record bytes using a high-speed zero-allocation table scanner (`computeRecordCrc`).
   - If the CRC matches:
     - For single `PUT` / `DEL`: updates the in-memory index `Map` with the value's file offset and length, and advances `lastValidCommittedOffset` to the end of the record.
     - For `BATCH_PUT` / `BATCH_DEL`: buffers the item under its `TxId` in a pending batch map.
     - For `BATCH_COMMIT`: verifies that all buffered items for that `TxId` are present and that their cumulative XOR checksum matches the commit marker's `BatchChecksum`. If verified, applies all batch operations in order to the index and advances `lastValidCommittedOffset` to the end of the commit marker.
   - If a torn record, partial header, invalid CRC, or missing batch commit is detected: **the scan halts immediately**.
4. **Tail Repair**: If `lastValidCommittedOffset < actualFileSize`, invokes `fs.ftruncateSync(fd, lastValidCommittedOffset)` followed by `fs.fsyncSync(fd)` to cleanly erase the incomplete tail.
5. **Ready**: The in-memory index is now fully populated with active live keys. Recovery completes in $< 2$ seconds for 1,000,000 keys.

---

## 5. Torture Testing Tool

The independent torture test runner stresses KVDB by launching concurrent writers against `serve` mode, logging acknowledged operations into an independent oracle, killing the child process with `kill -9` / `taskkill /F` at genuinely random millisecond intervals, and verifying full post-restart integrity.

### Running the Torture Tool
```bash
# Default 500 iterations with random seed:
node torture/torture.js --iterations 500 --seed 12345

# Targeted Modes:
node torture/torture.js --iterations 100 --seed 999 --mode large-values
node torture/torture.js --iterations 100 --seed 7   --mode compaction
node torture/torture.js --iterations 100 --seed 42  --mode recovery-crash
node torture/torture.js --iterations 100 --seed 55  --mode large-batches
node torture/torture.js --iterations 50  --seed 88  --mode disk-full
```

On Windows, `torture.cmd` is also provided:
```cmd
torture.cmd --iterations 500 --seed 12345
```

---

## 6. Performance Benchmarks

Run the 1,000,000 keys recovery benchmark:
```bash
node tests/benchmark_1m.js
```
*Result*: Recovers 1,000,000 keys with full CRC validation in **1.79 seconds** ($< 2.0\text{s}$ limit).

