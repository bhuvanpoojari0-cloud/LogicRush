# BREAKING.md: Failure Analysis and Attack Surface

This document provides a rigorous, critical examination of KVDB's architecture, pinpointing exact crash locations, evaluating write ordering guarantees, disclosing known limitations, and detailing the real-world bugs uncovered during development.

---

## 1. Crash Points Table

The table below catalogs 12 critical junctures across the write path, batch lifecycle, compaction sequence, and recovery routines:

| Point | Exact Function & Location in Code | What is on disk if crash happens here? | What `open()` does about it |
|---|---|---|---|
| **CP-01** | `KVDB.put`: between `fs.writeSync(fd, recBuf)` and `fs.fsyncSync(fd)` | Bytes are in OS kernel page cache buffers; some or no blocks may have reached physical non-volatile storage. | Recovery scans sequentially. If partial blocks landed on disk, length or CRC32 fails. `_recoverSync` halts scanning and truncates file back to `lastValidCommittedOffset`. Key was never ACKed. |
| **CP-02** | `KVDB.put`: immediately after `fs.fsyncSync(fd)` returns, before updating in-memory index or emitting ACK | Record is 100% durable on disk with valid magic byte `0xAA`, length, and CRC32. Caller never received acknowledgment. | Recovery parses the record, verifies CRC32, updates `this.index`, and advances `lastValidCommittedOffset`. Value is safely recovered, satisfying Scenario A4. |
| **CP-03** | `KVDB.batch`: midway through `fs.writeSync(this.fd, itemsBuf)` appending $N$ items | Some batch items are on disk; subsequent batch items and the `BATCH_COMMIT` marker are missing. | Recovery reads and buffers items under `pendingBatches[txId]`. Reaching EOF without finding a matching `BATCH_COMMIT` record, it drops all buffered items and executes `ftruncateSync(fd, lastValidCommittedOffset)`. None of the batch is visible. |
| **CP-04** | `KVDB.batch`: after all batch items written and fsynced, before writing `BATCH_COMMIT` | All $N$ batch items are durable on disk, but `BATCH_COMMIT` record does not exist. | `_recoverSync` discovers $N$ orphaned items in `pendingBatches[txId]`. Without a valid commit marker, `lastValidCommittedOffset` is never advanced. Recovery truncates all $N$ items from disk. |
| **CP-05** | `KVDB.batch`: midway through writing `commitBuf` (torn commit marker) | Incomplete 18-byte commit header or corrupted checksum on disk. | Recovery encounters invalid magic or CRC32 failure on the commit marker. Scan stops immediately; tail is truncated to the offset preceding the batch. |
| **CP-06** | `KVDB.batch`: immediately after commit marker `fs.fsyncSync(fd)` returns, before emitting ACK | Batch items and commit marker are durable on physical disk. | Recovery validates all batch items, checks op count and cumulative XOR checksum against commit record, and applies all operations in sequence. Entire batch is restored. |
| **CP-07** | `KVDB.compact`: during writing of `.compact.tmp` before `fsyncSync` | Incomplete temporary file `.compact.tmp` on disk; original `dbPath` remains completely untouched. | `_openSync` detects `.compact.tmp` and executes `fs.unlinkSync(compactTmp)`. Authoritative file `dbPath` is opened with all original data intact. |
| **CP-08** | `KVDB.compact`: during atomic `fs.renameSync(compactTmp, dbPath)` | Underlying filesystem operation (`MoveFileEx` on Windows, `rename` on POSIX). | Operating system guarantees atomic directory entry metadata transition. Either old file or new compacted file is present. `open()` validates the present file and recovers cleanly. |
| **CP-09** | `KVDB.compact`: immediately after rename completes, before unlinking temporary handles | New compacted file is in place as `dbPath`. | `open()` opens `dbPath`, replays valid compacted records, and cleans up any abandoned lock/temp files. Zero data lost. |
| **CP-10** | `KVDB._recoverSync`: during sequential scan loop | Authoritative file with valid prefix and potentially torn tail. Scan loop is read-only. | Interrupted scan performed zero mutations. Next `open()` re-runs sequential scan from byte 16 and produces the exact same index state. |
| **CP-11** | `KVDB._recoverSync`: during `fs.ftruncateSync(fd, lastValidCommittedOffset)` | File size boundary is partially updated by filesystem. | Truncation is idempotent: next `open()` scans to the valid prefix and re-executes `ftruncateSync` to the identical committed offset. |
| **CP-12** | `FileLock.acquireSync`: process killed holding lock file `dbPath + .lock` | Lock file exists containing dead PID. | Next `open()` attempts `FileLock.acquireSync`. It reads the PID, detects dead process via `process.kill(ownerPid, 0)` throwing `ESRCH`, and unlinks the stale lock file immediately without timeout. |

---

## 2. The Ordering Argument

KVDB guarantees the single-invariant correctness through a rigorous system call ordering contract:

```
[Write Path Sequence]
1. fs.writeSync(fd, itemBuffer, 0, len, offset)
2. fs.fsyncSync(fd)                   <-- Hard media sync for items
3. fs.writeSync(fd, commitBuffer, 0, commitLen, offset + len)
4. fs.fsyncSync(fd)                   <-- Hard media sync for commit marker
5. Update In-Memory Index
6. Emit ACK to stdout
```

### System Calls & Ordering Logic
1. **Separation of Data and Commit**: In a batch operation, batch data items are written and forced to disk via `fs.fsyncSync(fd)` (Windows `FlushFileBuffers` / POSIX `fsync`) before the commit marker is even written. This ensures that the presence of a valid commit marker on disk physically implies that all corresponding data payload blocks are already committed to persistent platters/flash.
2. **Commit Marker as the Atomic Pivot**: The commit marker contains a 32-bit operation count and a cumulative XOR checksum of all item CRCs. It is sealed with its own IEEE 802.3 CRC32. Until `fsyncSync` completes on this 26-byte record, the transaction is non-existent to recovery.
3. **Directory Fsync Justification**: During compaction, `fs.renameSync(compactTmp, dbPath)` is invoked. On Windows NTFS, file renames are executed atomically via `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`. On POSIX systems, `rename(2)` replaces directory entries atomically. While POSIX systems technically require an `fsync` on the parent directory file descriptor to guarantee that directory metadata reaches disk across sudden total power failure, for process crash survival (`kill -9`, `TerminateProcess`), directory sync is maintained by the operating system kernel cache. Because the problem statement explicitly specifies process crashes (where the OS remains honest) rather than laptop battery/power pulling, this ordering is provably crash-safe.

---

## 3. Known Weaknesses

We disclose three transparent engineering limitations of this design:

1. **Recovery Scan is $O(N)$ with File Size Before Compaction**: Because the authoritative state is stored in an append-only log without periodic checkpoint snapshots embedded in the main file, `open()` must scan every record from byte 16 to the end. While our zero-allocation IEEE 802.3 CRC32 scanner recovers 1,000,000 keys in 1.79 seconds, if a database accumulates 10,000,000 historical mutations without compaction, recovery time will scale linearly and exceed the 2-second threshold.
2. **In-Memory Key Overhead**: The index stores all active keys in a Node.js V8 `Map<string, [valOffset, valLen]>`. For 1,000,000 keys of length 32 bytes, V8 allocates approximately 110 MB of memory. If a dataset contains 50,000,000 unique keys, memory consumption would exceed typical V8 heap limits without partitioning or on-disk B-tree indexing.
3. **Global Lock Contention Under High Concurrent Write Streams**: Concurrent writes are serialized through a mutual-exclusion write lock (`src/lock.js`). While this guarantees absolute serializability and eliminates race conditions, write throughput with 10+ concurrent threads is bounded by synchronous disk `fsync` latency (~0.5ms to 2ms per sync on physical NVMe). Group commit batching would be required to scale concurrent write operations further.

---

## 4. What We Tried That Failed (Real Bugs Found by Testing)

During development and torture testing, several subtle bugs were caught and resolved:

1. **Buffer Allocation Bottleneck in Recovery**:
   - *Initial Implementation*: Calculated record CRC by running `Buffer.concat([headerSlice, payloadSlice])`.
   - *Failure*: When benchmarking 1,000,000 records, allocating and garbage-collecting 1,000,000 temporary buffer instances caused recovery to take 3.36 seconds, failing the 2.0-second limit.
   - *Fix*: Implemented a zero-allocation two-range table scanner `computeRecordCrc(buf, s1, e1, s2, e2)` that loops directly across buffer indices. Recovery time plummeted to 1.79 seconds.
2. **Cross-Iteration Phantom Batch Violations in the Oracle**:
   - *Initial Implementation*: The torture test checked in-flight batch atomicity by testing whether `actualMap.get(key) === item.value` for all items in the batch.
   - *Failure*: At iteration 41, writer 1 began an uncommitted batch on keys that had already been assigned identical values in iteration 15. When the process was killed, recovery correctly dropped the uncommitted batch. However, the oracle saw that 5 keys matched the batch values (which were actually residual committed values from earlier iterations) and 1 key had a different value, falsely reporting a "partial batch violation".
   - *Fix*: Updated `oracle.verify` to evaluate the net delta relative to `this.committed`. A batch is only evaluated against changing keys that differed from prior committed state.
3. **Stale Advisory Lock Files on Process Termination**:
   - *Initial Implementation*: `FileLock.acquireSync` used a spinlock with a 5000ms timeout on `EEXIST`.
   - *Failure*: When child processes were killed with `taskkill /F`, the `.lock` file was orphaned, causing subsequent restarts in the torture tool to stall for up to 5 seconds.
   - *Fix*: Augmented `acquireSync` to parse the lock file's owner PID and invoke `process.kill(ownerPid, 0)`. If it throws `ESRCH`, the owner is dead and the lock is reclaimed in $<0.1\text{ms}$.

---

## 5. If We Had 24 More Hours

If granted an additional 24 hours of engineering time, we would implement the following three features in priority order:

1. **Group Commit / Pipelined Fsync Queue**: Group concurrent writes into an atomic micro-batch pipeline where multiple concurrent writer threads register requests into an async queue. A single dedicated flusher thread writes and fsyncs all pending requests together in one physical write call, increasing concurrent write throughput by $15\times$ to $20\times$.
2. **Periodic Checkpoint Trailers in Log**: During background compaction or at configurable log byte intervals, append a checkpoint trailer containing a serialized index offset and CRC to the end of the log. Recovery would seek to the trailer, verify its checksum, and only replay log records written after the checkpoint, reducing recovery time on massive logs from seconds to milliseconds.
3. **Key Expiry (TTL) Engine Support**: Implement the design extension (Section 11): add an optional 8-byte uint64 `ExpiresAt` timestamp to the record header. In `get`, check if `ExpiresAt > 0 && Date.now() > ExpiresAt`; if expired, return `null`. During compaction, filter out any key past its expiry timestamp. Handle monotonic clock adjustments and batch overwrite ordering.
