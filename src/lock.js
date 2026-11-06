'use strict';

const fs = require('fs');

class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  acquireSync() {
    while (this._locked) {
      // spin
    }
    this._locked = true;
  }

  releaseSync() {
    this._locked = false;
  }
}

// File-level advisory lock with dead-process recovery
class FileLock {
  constructor(dbPath) {
    this.lockPath = dbPath + '.lock';
    this.fd = null;
  }

  acquireSync(timeoutMs = 5000) {
    const start = Date.now();
    while (true) {
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        const pidBuf = Buffer.from(String(process.pid) + '\n');
        fs.writeSync(this.fd, pidBuf);
        fs.fsyncSync(this.fd);
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Check if lock owner process is dead
          try {
            const content = fs.readFileSync(this.lockPath, 'utf8').trim();
            const ownerPid = parseInt(content, 10);
            if (!isNaN(ownerPid)) {
              try {
                process.kill(ownerPid, 0); // test liveness
              } catch (killErr) {
                if (killErr.code === 'ESRCH') {
                  // Process is dead! Immediately reclaim lock!
                  try { fs.unlinkSync(this.lockPath); } catch (e) {}
                  continue;
                }
              }
            }
          } catch (e) {}

          if (Date.now() - start > timeoutMs) {
            // Force reclaim if timed out
            try { fs.unlinkSync(this.lockPath); } catch (e) {}
            continue;
          }

          const endWait = Date.now() + 5;
          while (Date.now() < endWait) {}
        } else {
          throw err;
        }
      }
    }
  }

  releaseSync() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (e) {}
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch (e) {}
  }
}

module.exports = {
  Mutex,
  FileLock,
};
