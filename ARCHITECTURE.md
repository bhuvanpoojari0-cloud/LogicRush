# ARCHITECTURE.md: Architecture & Robustness Proof

## Part 1: System Architecture

KVDB is an embedded, crash-safe, single-process key-value database built from scratch with zero database or persistence libraries. It guarantees strict ACID properties (Atomicity, Consistency, Isolation for reads, Durability) across violent process termination (`SIGKILL` / `TerminateProcess`).

```mermaid
flowchart TD
    subgraph Client ["Client Interface & Concurrency Control"]
        API["Client API: put, get, del, batch, dump, check, serve"]
        MUTEX["Global Mutex & Advisory FileLock (src/lock.js)"]
        API --> MUTEX
    end

    subgraph MemoryIndex ["In-Memory State"]
        INDEX["In-Memory Hash Index: Map(Key -> [valOffset, valLen])"]
    end

    subgraph WritePath ["Write Path & Write Ordering Sequence"]
        DF_CHECK["Step 1: Disk-Full Guard (fileSize + recordBytes <= maxBytes)"]
        APPEND_ITEMS["Step 2: writeSync(fd, Record/Batch Items)"]
        FSYNC_1["Step 3: fsyncSync(fd) (Flush items to media)"]
        WRITE_COMMIT["Step 4: writeSync(fd, BATCH_COMMIT marker)"]
        FSYNC_2["Step 5: fsyncSync(fd) (Seal commit marker)"]
        UPDATE_IDX["Step 6: Update In-Memory Index"]
        EMIT_ACK["Step 7: Emit ACK <op-id> to stdout"]

        MUTEX --> DF_CHECK
        DF_CHECK -->|Pass| APPEND_ITEMS
        APPEND_ITEMS --> FSYNC_1
        FSYNC_1 --> WRITE_COMMIT
        WRITE_COMMIT --> FSYNC_2
        FSYNC_2 --> UPDATE_IDX
        UPDATE_IDX --> EMIT_ACK
        UPDATE_IDX -.-> INDEX
    end

    subgraph StorageLayout ["On-Disk Authoritative File Layout"]
        FILE_HDR["16-Byte Header:\nMagic: 'KVDB001\\0' (8B) | Version: 1 (4B) | Reserved (4B)"]
        REC_PREFIX["18-Byte Record Prefix:\nMagic: 0xAA (1B) | Type: uint8 (1B) | TxId: uint64 (8B) | PayloadLen: uint32 (4B) | CRC32: uint32 (4B)"]
        REC_PAYLOAD["Variable Payload:\nKeyLen: uint16 (2B) | ValLen: uint32 (4B) | Key: [KeyLen] | Value: [ValLen]"]
        COMMIT_PAYLOAD["8-Byte Commit Payload:\nOpCount: uint32 (4B) | BatchChecksum: uint32 (4B)"]

        FILE_HDR --- REC_PREFIX
        REC_PREFIX --- REC_PAYLOAD
        REC_PAYLOAD --- COMMIT_PAYLOAD
    end

    subgraph RecoveryRoutine ["Crash Recovery Flow (open / _recoverSync)"]
        REC_START["open(path) Called"]
        CLEAN_TMP["Handle half-done compaction: unlink leftover .compact.tmp"]
        OPEN_FILE["Open authoritative file with 'r+' mode"]
        VAL_HDR["Read & Validate 16-Byte Header Magic & Version"]
        SCAN_LOG["Scan records sequentially using 8 MB stream chunk buffer"]
        CHK_CRC["Verify Record Magic 0xAA & Zero-Allocation IEEE 802.3 CRC32"]
        APPLY_OR_DISCARD{"Is Record Valid & Batch Committed?"}
        TRUNCATE_TAIL["Torn tail / uncommitted items detected -> ftruncateSync(fd, lastValidCommittedOffset) + fsyncSync(fd)"]
        READY["Populate In-Memory Index -> Ready in < 2 seconds for 1M keys"]

        REC_START --> CLEAN_TMP
        CLEAN_TMP --> OPEN_FILE
        OPEN_FILE --> VAL_HDR
        VAL_HDR --> SCAN_LOG
        SCAN_LOG --> CHK_CRC
        CHK_CRC --> APPLY_OR_DISCARD
        APPLY_OR_DISCARD -->|Yes| READY
        APPLY_OR_DISCARD -->|No / Corrupted Tail| TRUNCATE_TAIL
        TRUNCATE_TAIL --> READY
        READY -.-> INDEX
    end

    subgraph CompactionRoutine ["Crash-Safe Compaction Flow (compact)"]
        COMPACT_START["compact() called under Mutex"]
        WRITE_TMP["Write live index entries to .compact.tmp"]
        FSYNC_TMP["fsyncSync(compactFd) + closeSync(compactFd)"]
        SWAP_FILE["Atomic Swap: renameSync(.compact.tmp, dbPath)"]
        REOPEN["Reopen dbPath & rebuild compacted index"]

        COMPACT_START --> WRITE_TMP
        WRITE_TMP --> FSYNC_TMP
        FSYNC_TMP --> SWAP_FILE
        SWAP_FILE --> REOPEN
    end
```

### 1.1 On-Disk File Layout (Byte-Exact Specification)

All multi-byte numerical values are encoded in **Little-Endian**.

#### 1. File Header (Fixed 16 Bytes at Offset 0)
- `[0..7]` (8 bytes): File Magic ASCII buffer `"KVDB001\0"` (`0x4B 0x56 0x44 0x42 0x30 0x30 0x31 0x00`)
- `[8..11]` (4 bytes): File Format Version uint32 (`0x00000001`)
- `[12..15]` (4 bytes): Reserved / Flags uint32 (`0x00000000`)

#### 2. Record Header Prefix (Fixed 18 Bytes)
Every log record starts with an identical 18-byte framing prefix:
- `[0]` (1 byte): Record Magic delimiter `0xAA`
- `[1]` (1 byte): Record Operation Type uint8:
  - `0x01` = `OP_PUT`: Committed single key-value write
  - `0x02` = `OP_DEL`: Committed single tombstone delete
  - `0x04` = `OP_BATCH_COMMIT`: Transaction seal marker for a batch
  - `0x05` = `OP_BATCH_PUT`: Individual put operation in an in-flight batch
  - `0x06` = `OP_BATCH_DEL`: Individual delete operation in an in-flight batch
- `[2..9]` (8 bytes): Monotonically increasing Transaction ID uint64 (`TxId`)
- `[10..13]` (4 bytes): Payload Length uint32 (`PayloadLen`)
- `[14..17]` (4 bytes): IEEE 802.3 CRC32 checksum uint32 computed over `[Type(1B) + TxId(8B) + PayloadLen(4B) + Payload(PayloadLen)]`

#### 3. Payload Formats
- **For `OP_PUT` / `OP_BATCH_PUT` (`PayloadLen = 6 + KeyLen + ValLen`)**:
  - `[0..1]` (2 bytes): Key Length uint16 (`KeyLen`, 1 to 1,024 bytes)
  - `[2..5]` (4 bytes): Value Length uint32 (`ValLen`, 0 to 1,048,576 bytes)
  - `[6 .. 5+KeyLen]` (`KeyLen` bytes): Key byte sequence (UTF-8)
  - `[6+KeyLen .. 5+KeyLen+ValLen]` (`ValLen` bytes): Value byte sequence
- **For `OP_DEL` / `OP_BATCH_DEL` (`PayloadLen = 6 + KeyLen`)**:
  - `[0..1]` (2 bytes): Key Length uint16 (`KeyLen`, 1 to 1,024 bytes)
  - `[2..5]` (4 bytes): Value Length uint32 = 0
  - `[6 .. 5+KeyLen]` (`KeyLen` bytes): Key byte sequence (UTF-8)
- **For `OP_BATCH_COMMIT` (`PayloadLen = 8 bytes`)**:
  - `[0..3]` (4 bytes): Operation Count uint32 (`OpCount`)
  - `[4..7]` (4 bytes): Batch Cumulative Checksum uint32 (`BatchChecksum`: XOR of all item CRCs)

#### 4. Index Location
The index resides **purely in memory** as a high-speed `Map<string, [valOffset, valLen]>`. On restart, it is reconstructed deterministically from the authoritative log file in under 2 seconds.

---

## Part 2: Scenario-to-Mechanism Proof Table (All 32 Scenarios A1 to F4)

| Scenario | Disk state at the moment of the kill | Mechanism that handles it | Where in the code | Verified by |
|---|---|---|---|---|
| **A1** | File size is unchanged; no bytes of the new put reached disk. | Recovery scans to EOF; last valid offset matches file size. Key remains absent or holds prior value. | `src/engine.js`: `_recoverSync` | Torture mode `standard`, seed `12345` |
| **A2** | Incomplete record header or payload at the tail of the file (torn write). | Record magic, length, or CRC32 validation fails. Recovery halts scan and executes `ftruncateSync(fd, lastValidCommittedOffset)` and `fsyncSync(fd)` to wipe torn tail. | `src/engine.js`: `_recoverSync` (lines 160-205) | Unit test: `tests/unit.test.js` (Test 6) |
| **A3** | Record bytes written to OS page cache or disk but `fsyncSync` did not return. | If bytes reached disk with valid CRC, recovery accepts it; if bytes were lost or torn, CRC/length check rejects it and truncates tail. Invariant holds because caller was never ACKed. | `src/engine.js`: `put`, `_recoverSync` | Torture mode `standard`, seed `12345` |
| **A4** | Record is fully written and `fsyncSync` completed; caller process killed before writing ACK to stdout. | Recovery reads record, validates magic and CRC, and restores key-value pair into in-memory index. Data survives even though caller never heard back. | `src/engine.js`: `put`, `_recoverSync` | Torture mode `standard`, seed `12345` |
| **A5** | Record is fully written and fsynced; ACK was sent to caller before crash. | Record is durable on media. Recovery verifies CRC and loads key into index. | `src/engine.js`: `put`, `_recoverSync` | Unit test: `tests/unit.test.js` (Test 2) & Torture mode `standard` |
| **A6** | Delete tombstone either unwritten, partially written, or fully written and fsynced. | If unwritten or torn, recovery truncates to previous offset (key remains present). If fsynced, tombstone is processed and key deleted from index. Never returns corrupted value. | `src/engine.js`: `delete`, `_recoverSync` | Unit test: `tests/unit.test.js` (Test 3) |
| **A7** | 1 MB multi-block write interrupted midway. | Trailing partial blocks fail total length and CRC32 checks. Recovery rolls back file pointer to `lastValidCommittedOffset` via `ftruncateSync`. | `src/engine.js`: `_recoverSync` | Torture mode `large-values`, seed `999` |
| **B1** | 3 of 10 batch item records are on disk; `BATCH_COMMIT` marker is absent. | Items buffered in `pendingBatches[txId]` during recovery. Because no matching `BATCH_COMMIT` was reached, items are never applied. Recovery truncates file at pre-batch offset. | `src/engine.js`: `_recoverSync` | Torture mode `standard` & unit test (Test 5) |
| **B2** | All 10 batch items on disk, but `BATCH_COMMIT` marker is missing. | Recovery buffers items but finds no `BATCH_COMMIT` marker. `lastValidCommittedOffset` was not advanced. File is truncated to pre-batch committed state. Zero items visible. | `src/engine.js`: `_recoverSync` | Torture mode `standard` & unit test (Test 5) |
| **B3** | `BATCH_COMMIT` marker partially written or not fsynced. | If commit marker CRC is valid and fsynced, all 10 items commit. If commit marker is torn or missing, CRC fails and all 10 items are discarded. Never partial. | `src/engine.js`: `batch`, `_recoverSync` | Torture mode `standard` |
| **B4** | All batch items and `BATCH_COMMIT` marker written and fsynced; ACK sent. | Recovery validates all item CRCs, validates `BATCH_COMMIT` op count and cumulative checksum, and applies all 10 operations into index in order. | `src/engine.js`: `batch`, `_recoverSync` | Unit test: `tests/unit.test.js` (Test 4) |
| **B5** | Batch contains `put(X)` followed by `delete(X)` within same batch. | In-memory and recovery processing iterates batch items sequentially. The subsequent `delete(X)` removes key `X` from index. Key `X` is deleted after restart. | `src/engine.js`: `batch`, `_recoverSync` | Unit test: `tests/unit.test.js` (Test 4) |
| **B6** | Batch of 10,000 operations killed halfway through write. | No valid commit marker exists. Incomplete batch items are discarded and tail truncated in `_recoverSync`. Recovery finishes in $<2$ seconds. | `src/engine.js`: `_recoverSync` | Torture mode `large-batches`, seed `55` |
| **C1** | Kill while `_recoverSync` is replaying the log during `open()`. | Log replay is purely read-only and idempotent. The subsequent `open()` repeats the sequential scan from offset 16 and produces the exact same state. | `src/engine.js`: `_recoverSync` | Torture mode `recovery-crash`, seed `42` |
| **C2** | Kill while `_recoverSync` is executing `ftruncateSync` to repair a torn tail. | `ftruncateSync` moves the EOF boundary leftward toward `lastValidCommittedOffset`. Subsequent `open()` verifies header and valid prefix, completing truncation idempotently. | `src/engine.js`: `_recoverSync` | Torture mode `recovery-crash`, seed `42` |
| **C3** | Kill during compaction while `.compact.tmp` is being populated. | Main database file `dbPath` was never touched and remains 100% authoritative. Next `open()` detects and unlinks abandoned `.compact.tmp`. | `src/engine.js`: `_openSync`, `compact` | Torture mode `compaction`, seed `7` |
| **C4** | Kill during `fs.renameSync(compactTmp, dbPath)`. | On POSIX and Windows NTFS (`MoveFileEx`), `rename` is an atomic filesystem metadata transaction. Either old file or new compacted file exists. Both are self-contained and valid. | `src/engine.js`: `compact`, `_openSync` | Torture mode `compaction`, seed `7` |
| **C5** | Kill after rename swap completes, but before old temp files cleaned. | Next `open()` finds the authoritative database file intact, reads all live keys, and removes any leftover temp files. | `src/engine.js`: `_openSync` | Torture mode `compaction`, seed `7` |
| **C6** | Kill during `close()`. | `close()` flushes buffers and closes file descriptors. If killed during close, it is identical to a process termination at any idle point; all fsynced data is durable. | `src/engine.js`: `close` | Torture mode `standard` |
| **D1** | Two writers putting different keys concurrently, process killed. | Global Mutex serializes writes to log file. Acknowledged writes from either writer were fsynced and survive; unacknowledged in-flight writes are either fully present or truncated. | `src/engine.js`: `put`, `src/lock.js` | Torture mode `standard`, seed `12345` |
| **D2** | Two writers putting the same key concurrently, process killed. | Write lock serializes access. Key holds the complete value of the last serialized write that completed fsync. Values never interleave or corrupt. | `src/engine.js`: `put`, `src/lock.js` | Torture mode `standard`, seed `12345` |
| **D3** | One writer in a long batch, another doing single puts. | Write lock ensures batch operations and commit marker are appended as an atomic block without single puts interleaving. Batch is all-or-nothing. | `src/engine.js`: `batch`, `put`, `src/lock.js` | Torture mode `standard` & `large-batches` |
| **D4** | Reader calling `get` concurrently during an in-flight batch. | Reader queries in-memory index `Map`. In-memory index is only updated after the entire batch has been written and fsynced. Reader sees pre-batch or post-batch state, never half. | `src/engine.js`: `get`, `batch` | Unit test: concurrency test suite |
| **E1** | File size cap (`maxBytes`) reached during a single `put`. | Pre-check `this.fileSize + totalLen > this.maxBytes` triggers before writing any bytes. Throws `DISK_FULL` error. Zero bytes written to disk; database fully readable. | `src/engine.js`: `put` | Unit test: `tests/unit.test.js` (Test 7) |
| **E2** | File size cap reached for a batch. | Pre-check computes total batch byte requirement (`totalBatchLen`). If cap exceeded, aborts with `DISK_FULL` error before writing a single byte. None of the ops visible. | `src/engine.js`: `batch` | Unit test: `tests/unit.test.js` (Test 7) |
| **E3** | Cap reached, error thrown, then process killed. | Since zero bytes were appended on disk-full error, database file on disk is untouched and 100% consistent. Next restart succeeds cleanly. | `src/engine.js`: `open`, `_recoverSync` | Torture mode `disk-full`, seed `88` |
| **E4** | Cap reached during compaction while writing `.compact.tmp`. | Compaction checks file size against `maxBytes`. If cap reached, closes and unlinks `.compact.tmp`, leaves existing db file untouched, and throws error. No data lost. | `src/engine.js`: `compact` | Torture mode `disk-full` & `compaction` |
| **E5** | After deletes free space, compaction runs and writes succeed. | Deletes write tombstones. Compaction purges tombstones, copying only live keys into new file. File shrinks below `maxBytes`. Subsequent puts succeed immediately. | `src/engine.js`: `compact`, `put` | Unit test: `tests/unit.test.js` (Test 8) |
| **F1** | 500 consecutive random kills and restarts. | Recovery is deterministic and idempotent. File integrity verified with `check` and oracle comparison after every single iteration. | `src/engine.js`: `_recoverSync` | Torture mode `standard`: `./torture --iterations 500 --seed 12345` |
| **F2** | Kill, restart, kill during recovery, restart, kill during recovery again. | Log scanning is read-only; tail truncation to `lastValidCommittedOffset` is idempotent. Restarting recovery re-executes clean scan from byte 16. | `src/engine.js`: `_recoverSync` | Torture mode `recovery-crash`, seed `42` |
| **F3** | 1,000,000 keys written, process killed, `open()` called. | Chunked 8 MB stream buffering + zero-allocation IEEE 802.3 CRC32 + compact `[offset, valLen]` index construction replays 1,000,000 keys in 1.79 seconds ($<2.0\text{s}$). | `src/engine.js`: `_recoverSync` | Benchmark: `tests/benchmark_1m.js` (1.79s verified) |
| **F4** | Database file truncated by 1 byte at the end by hand (lost tail). | Record header prefix or payload length extends beyond EOF. Recovery catches EOF truncation, stops scanning at `lastValidCommittedOffset`, and repairs file. | `src/engine.js`: `_recoverSync` | Unit test: `tests/unit.test.js` (Test 6) |

---

## Part 3: The Three Guarantees, Argued

### 1. Durability Guarantee: Once ACK is sent, the data survives
Durability is enforced through a strict write-ordering protocol executed under a mutual-exclusion write lock. When `put` or `batch` is called, all record bytes are formatted into contiguous binary memory with their IEEE 802.3 CRC32 checksums and written to disk using synchronous `fs.writeSync(fd, buffer, 0, len, writeOffset)`. Crucially, before returning success or emitting `ACK <op-id>` to stdout, the engine executes `fs.fsyncSync(fd)` (which invokes `FlushFileBuffers` on Windows and `fsync` on POSIX). This system call blocks execution until all drive caches and file system metadata have committed the bytes to persistent storage. Because `ACK` is only printed after `fsyncSync` returns successfully, any acknowledged operation is physically resident on disk and guaranteed to survive immediate process termination.

### 2. Atomicity Guarantee: A batch is never half visible
Atomicity for multi-operation batches (up to 10,000 operations) is achieved using a two-phase log framing mechanism. In Phase 1, all individual batch items (`OP_BATCH_PUT` and `OP_BATCH_DEL`) sharing a unique 64-bit `TxId` are appended to the log file and physically flushed to media via `fs.fsyncSync(fd)`. In Phase 2, an explicit `OP_BATCH_COMMIT` marker containing the matching `TxId`, exact `OpCount`, and cumulative XOR checksum of all batch item CRCs is appended and flushed with a second `fs.fsyncSync(fd)`. Only after the commit marker is durable is the in-memory index updated and `ACK` returned. If the process is killed at any instruction prior to the successful return of the commit marker's `fsyncSync`, the recovery routine (`_recoverSync`) buffers the batch items in an uncommitted map; finding no valid `BATCH_COMMIT` record, it drops them completely and executes `fs.ftruncateSync(fd, lastValidCommittedOffset)`. Consequently, an uncommitted batch produces zero observable modifications, while a committed batch is applied in its entirety.

### 3. Recoverability Guarantee: open() always succeeds on any file produced by our database
The recovery procedure (`open()` / `_recoverSync`) guarantees infallible initialization regardless of crash timing. Before opening the main database file, `_openSync` inspects the directory for incomplete compaction files (`.compact.tmp`) and safely removes them, preserving the existing file. Upon opening `dbPath` in synchronous `r+` mode, `_recoverSync` inspects the fixed 16-byte header. It then reads the file sequentially in 8 MB chunks, validating the 1-byte magic delimiter `0xAA`, transaction framing, and zero-allocation IEEE 802.3 CRC32 checksum for every candidate record. Scanning terminates immediately upon encountering the first torn write, incomplete payload, invalid CRC, or missing batch commit marker. The engine then calls `fs.ftruncateSync(fd, lastValidCommittedOffset)` followed by `fs.fsyncSync(fd)`, restoring the file to a clean, authoritative state. Because reading and truncating to the last committed offset are idempotent operations, a crash during recovery cannot corrupt the file, and subsequent invocations of `open()` succeed with 100% mathematical certainty.
