'use strict';

const fs = require('fs');

class Oracle {
  constructor(logPath) {
    this.logPath = logPath;
    this.committed = new Map(); // key -> value (string)
    this.inFlight = new Map();  // opId -> op details
    try {
      if (fs.existsSync(this.logPath)) {
        fs.unlinkSync(this.logPath);
      }
    } catch (e) {}
  }

  recordInFlight(opId, op) {
    this.inFlight.set(String(opId), op);
  }

  recordAck(opId) {
    const idStr = String(opId);
    const op = this.inFlight.get(idStr);
    if (!op) return;

    if (op.type === 'put') {
      this.committed.set(op.key, op.value);
      this._appendLog(`ACK PUT ${opId} ${op.key} ${op.value}`);
    } else if (op.type === 'del') {
      this.committed.delete(op.key);
      this._appendLog(`ACK DEL ${opId} ${op.key}`);
    } else if (op.type === 'batch') {
      for (const item of op.ops) {
        if (item.type === 'put') {
          this.committed.set(item.key, item.value);
        } else if (item.type === 'del') {
          this.committed.delete(item.key);
        }
      }
      this._appendLog(`ACK BATCH ${opId} ${op.ops.length}`);
    }
    this.inFlight.delete(idStr);
  }

  _appendLog(line) {
    if (this.logPath) {
      try {
        fs.appendFileSync(this.logPath, line + '\n');
      } catch (e) {}
    }
  }

  /**
   * Verify dumped database state against oracle:
   * Rule 1: Every ACKed operation must be present.
   * Rule 2: In-flight operations may be either completely present or completely absent.
   * Rule 3: In-flight batches must be all present or all absent.
   * Rule 4: No key may ever hold an unknown or torn value.
   */
  verify(actualDump) {
    const actualMap = new Map();
    for (const item of actualDump) {
      actualMap.set(item.key, item.value);
    }

    // 1. Check all committed ACKed keys
    for (const [key, expectedVal] of this.committed.entries()) {
      if (!actualMap.has(key)) {
        let unackedDel = false;
        for (const op of this.inFlight.values()) {
          if (op.type === 'del' && op.key === key) unackedDel = true;
          if (op.type === 'batch') {
            for (const item of op.ops) {
              if (item.type === 'del' && item.key === key) unackedDel = true;
            }
          }
        }
        if (!unackedDel) {
          return {
            valid: false,
            error: `Committed key '${key}' missing from database! Expected value '${expectedVal}'`,
          };
        }
      } else {
        const actualVal = actualMap.get(key);
        if (actualVal !== expectedVal) {
          let unackedPutMatch = false;
          for (const op of this.inFlight.values()) {
            if (op.type === 'put' && op.key === key && op.value === actualVal) {
              unackedPutMatch = true;
              break;
            }
            if (op.type === 'batch') {
              for (const item of op.ops) {
                if (item.type === 'put' && item.key === key && item.value === actualVal) {
                  unackedPutMatch = true;
                }
              }
            }
          }
          if (!unackedPutMatch) {
            return {
              valid: false,
              error: `Value mismatch for key '${key}': expected '${expectedVal}', got '${actualVal}'`,
            };
          }
        }
      }
    }

    // 2. Check for unexpected keys in actual dump that were never committed
    for (const [key, actualVal] of actualMap.entries()) {
      if (!this.committed.has(key)) {
        let foundInFlight = false;
        for (const op of this.inFlight.values()) {
          if (op.type === 'put' && op.key === key && op.value === actualVal) {
            foundInFlight = true;
            break;
          }
          if (op.type === 'batch') {
            for (const item of op.ops) {
              if (item.type === 'put' && item.key === key && item.value === actualVal) {
                foundInFlight = true;
                break;
              }
            }
          }
        }
        if (!foundInFlight) {
          return {
            valid: false,
            error: `Unexpected key '${key}' with value '${actualVal}' present in database, not in oracle!`,
          };
        }
      }
    }

    // 3. Batch Atomicity Check on in-flight batches
    for (const [opId, op] of this.inFlight.entries()) {
      if (op.type === 'batch') {
        const netEffects = new Map();
        for (const item of op.ops) {
          netEffects.set(item.key, item);
        }

        // Compare against previous committed state
        let newlyAppliedCount = 0;
        let retainedOldCount = 0;
        let totalChangingOps = 0;

        for (const [key, item] of netEffects.entries()) {
          const oldVal = this.committed.has(key) ? this.committed.get(key) : undefined;
          const actualVal = actualMap.has(key) ? actualMap.get(key) : undefined;

          if (item.type === 'put') {
            if (oldVal !== item.value) {
              totalChangingOps++;
              if (actualVal === item.value) {
                newlyAppliedCount++;
              } else if (actualVal === oldVal) {
                retainedOldCount++;
              }
            }
          } else if (item.type === 'del') {
            if (oldVal !== undefined) {
              totalChangingOps++;
              if (actualVal === undefined) {
                newlyAppliedCount++;
              } else if (actualVal === oldVal) {
                retainedOldCount++;
              }
            }
          }
        }

        // If some changing operations were applied and some retained old state -> Atomicity Violation!
        if (newlyAppliedCount > 0 && retainedOldCount > 0) {
          return {
            valid: false,
            error: `Partial batch violation in batch ${opId}: ${newlyAppliedCount} applied, ${retainedOldCount} retained old state out of ${totalChangingOps} changing operations!`,
          };
        }
      }
    }

    // Synchronize oracle's committed map with actual database state for next iteration
    this.committed = new Map(actualMap);
    this.inFlight.clear();

    return { valid: true };
  }
}

module.exports = {
  Oracle,
};
