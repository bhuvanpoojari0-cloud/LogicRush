'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { Oracle } = require('./oracle');
const { KVDB } = require('../src/engine');

// Mulberry32 Deterministic PRNG
function createPRNG(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Command-line argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    iterations: 500,
    seed: Math.floor(Math.random() * 1000000),
    mode: 'standard', // standard, large-values, large-batches, compaction, recovery-crash, disk-full
    dbPath: path.resolve('torture_test.db'),
    oracleLog: path.resolve('oracle.log'),
    maxBytes: 0,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      config.iterations = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--seed' && args[i + 1]) {
      config.seed = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      config.mode = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--db' && args[i + 1]) {
      config.dbPath = path.resolve(args[i + 1]);
      i++;
    }
  }

  if (config.mode === 'disk-full') {
    config.maxBytes = 64 * 1024; // 64 KB cap to force disk full
  }

  return config;
}

function hardKill(childPid) {
  if (!childPid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /PID ${childPid} >nul 2>&1`);
    } catch (e) {
      try { process.kill(childPid, 'SIGKILL'); } catch (err) {}
    }
  } else {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch (e) {}
  }
}

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runIteration(iter, config, rand, oracle) {
  // 1. Determine configuration based on mode
  let minKillDelay = 5;
  let maxKillDelay = 35;
  let writer1ValSize = 64;
  let writer2ValSize = 128;
  let isLargeBatch = false;
  let triggerCompaction = false;

  if (config.mode === 'large-values') {
    writer1ValSize = 1024 * 1024; // 1 MB
    writer2ValSize = 512 * 1024;  // 512 KB
    minKillDelay = 2;
    maxKillDelay = 25;
  } else if (config.mode === 'large-batches') {
    isLargeBatch = true;
    minKillDelay = 1;
    maxKillDelay = 30;
  } else if (config.mode === 'compaction') {
    triggerCompaction = true;
    minKillDelay = 5;
    maxKillDelay = 25;
  }

  // 3. Start child process in serve mode
  const cliScript = path.resolve(__dirname, '../src/cli.js');
  const serverArgs = [cliScript, 'serve', config.dbPath];
  if (config.maxBytes > 0) {
    serverArgs.push('--max-bytes', String(config.maxBytes));
  }

  const child = spawn(process.execPath, serverArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});

  // Track ACKs
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, idx).trim();
      buffer = buffer.substring(idx + 1);
      if (line.startsWith('ACK ')) {
        const ackId = line.substring(4).trim();
        oracle.recordAck(ackId);
      }
    }
  });

  // 4. Run Two Concurrent Writers
  let running = true;
  let opSeq = 1;

  async function writer(writerId) {
    while (running && child.stdin && !child.stdin.destroyed) {
      try {
        const opType = rand() < 0.7 ? 'put' : (rand() < 0.9 ? 'batch' : 'del');
        const opId = `${iter}_w${writerId}_${opSeq++}`;
        const key = `k_${Math.floor(rand() * 100)}`;

        if (triggerCompaction && rand() < 0.05) {
          child.stdin.write(`compact ${opId}\n`);
          await sleep(5);
          continue;
        }

        if (isLargeBatch) {
          // Large batch up to 10,000 ops
          const batchCount = Math.floor(rand() * 2000) + 1000;
          const ops = [];
          child.stdin.write(`batch ${opId} ${batchCount}\n`);
          for (let i = 0; i < batchCount; i++) {
            const bKey = `bkey_${i}`;
            const bVal = `bval_${i}_${rand()}`;
            ops.push({ type: 'put', key: bKey, value: bVal });
            child.stdin.write(`put ${bKey} ${bVal}\n`);
          }
          oracle.recordInFlight(opId, { type: 'batch', ops });
        } else if (opType === 'put') {
          const valSize = writerId === 1 ? writer1ValSize : writer2ValSize;
          const val = 'x'.repeat(Math.max(1, Math.floor(rand() * valSize)));
          oracle.recordInFlight(opId, { type: 'put', key, value: val });
          child.stdin.write(`put ${opId} ${key} ${val}\n`);
        } else if (opType === 'del') {
          oracle.recordInFlight(opId, { type: 'del', key });
          child.stdin.write(`del ${opId} ${key}\n`);
        } else {
          // Small batch
          const batchCount = Math.floor(rand() * 8) + 2;
          const ops = [];
          child.stdin.write(`batch ${opId} ${batchCount}\n`);
          for (let i = 0; i < batchCount; i++) {
            const bKey = `bk_${Math.floor(rand() * 50)}`;
            const bVal = `bv_${Math.floor(rand() * 1000)}`;
            ops.push({ type: 'put', key: bKey, value: bVal });
            child.stdin.write(`put ${bKey} ${bVal}\n`);
          }
          oracle.recordInFlight(opId, { type: 'batch', ops });
        }
        await sleep(Math.floor(rand() * 5) + 1);
      } catch (e) {
        break;
      }
    }
  }

  const w1 = writer(1);
  const w2 = writer(2);

  // 5. Hard Kill at genuinely random millisecond delay
  const killDelay = Math.floor(rand() * (maxKillDelay - minKillDelay)) + minKillDelay;
  await sleep(killDelay);
  running = false;
  hardKill(child.pid);
  await Promise.allSettled([w1, w2]);

  // Handle recovery-crash mode: kill during recovery!
  if (config.mode === 'recovery-crash') {
    const recChild = spawn(process.execPath, [cliScript, 'open', config.dbPath], {
      stdio: 'ignore',
    });
    const recKillDelay = Math.floor(rand() * 10) + 1;
    await sleep(recKillDelay);
    hardKill(recChild.pid);
  }

  // 6. Restart Database, run check, and verify dump
  try {
    const db = await KVDB.open(config.dbPath);
    const checkResult = await db.check();
    if (!checkResult.ok) {
      return {
        pass: false,
        error: `Integrity check failed: ${checkResult.reason}`,
      };
    }

    const dump = await db.dump();
    db.close();

    // Verify dump against independent oracle
    const verifyResult = oracle.verify(dump);
    if (!verifyResult.valid) {
      return {
        pass: false,
        error: verifyResult.error,
      };
    }

    return { pass: true, keys: dump.length };
  } catch (err) {
    return {
      pass: false,
      error: `Database open/recovery threw exception: ${err.message}`,
    };
  }
}

async function main() {
  const config = parseArgs();
  console.log('================================================================');
  console.log('              KILL IT AND PROVE IT: TORTURE TOOL                ');
  console.log('================================================================');
  console.log(`Iterations: ${config.iterations}`);
  console.log(`Seed:       ${config.seed}`);
  console.log(`Mode:       ${config.mode}`);
  console.log(`Target DB:  ${config.dbPath}`);
  console.log('----------------------------------------------------------------');

  const rand = createPRNG(config.seed);

  // Clean test DB before starting run
  try {
    if (fs.existsSync(config.dbPath)) fs.unlinkSync(config.dbPath);
    const lock = config.dbPath + '.lock';
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch (e) {}

  let passed = 0;
  const startTime = Date.now();
  const oracle = new Oracle(config.oracleLog);

  for (let i = 1; i <= config.iterations; i++) {
    const result = await runIteration(i, config, rand, oracle);
    if (!result.pass) {
      console.error(`\n[FAIL] Iteration ${i} failed invariant!`);
      console.error(`Error: ${result.error}`);
      console.error(`Reproduce with: --seed ${config.seed} --mode ${config.mode}`);
      process.exit(1);
    }

    passed++;
    if (i % 25 === 0 || i === config.iterations || i <= 5) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[PASS] Iteration ${i}/${config.iterations} OK (${result.keys} keys, ${elapsed}s elapsed)`);
    }
  }

  console.log('----------------------------------------------------------------');
  console.log(`ALL ${passed} ITERATIONS PASSED! ZERO INVARIANT VIOLATIONS.`);
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Torture runner error:', err);
  process.exit(1);
});
