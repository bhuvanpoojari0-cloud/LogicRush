'use strict';

const fs = require('fs');
const readline = require('readline');
const { KVDB } = require('./engine');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0].toLowerCase();

  try {
    switch (command) {
      case 'open': {
        const dbPath = args[1];
        if (!dbPath) throw new Error('Usage: kvdb open <path> [--max-bytes N]');
        let maxBytes = 0;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--max-bytes' && args[i + 1]) {
            maxBytes = Number(args[i + 1]);
            i++;
          }
        }
        const db = await KVDB.open(dbPath, { maxBytes });
        const count = db.getKeyCount();
        console.log(`Keys: ${count}`);
        db.close();
        break;
      }

      case 'put': {
        const dbPath = args[1];
        const key = args[2];
        const val = args[3];
        if (!dbPath || key === undefined || val === undefined) {
          throw new Error('Usage: kvdb put <path> <key> <value>');
        }
        const db = await KVDB.open(dbPath);
        await db.put(key, val);
        db.close();
        break;
      }

      case 'get': {
        const dbPath = args[1];
        const key = args[2];
        if (!dbPath || key === undefined) {
          throw new Error('Usage: kvdb get <path> <key>');
        }
        const db = await KVDB.open(dbPath);
        const val = await db.get(key);
        db.close();
        if (val === null) {
          console.log('NOTFOUND');
        } else {
          process.stdout.write(val.toString('utf8') + '\n');
        }
        break;
      }

      case 'del': {
        const dbPath = args[1];
        const key = args[2];
        if (!dbPath || key === undefined) {
          throw new Error('Usage: kvdb del <path> <key>');
        }
        const db = await KVDB.open(dbPath);
        await db.delete(key);
        db.close();
        break;
      }

      case 'batch': {
        const dbPath = args[1];
        const batchFile = args[2];
        if (!dbPath || !batchFile) {
          throw new Error('Usage: kvdb batch <path> <file>');
        }
        if (!fs.existsSync(batchFile)) {
          throw new Error(`Batch file not found: ${batchFile}`);
        }
        const content = fs.readFileSync(batchFile, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const ops = [];
        for (const line of lines) {
          const parts = line.split(/\s+/);
          const opType = parts[0].toLowerCase();
          if (opType === 'put') {
            const k = parts[1];
            const v = parts.slice(2).join(' ');
            ops.push({ type: 'put', key: k, value: v });
          } else if (opType === 'del' || opType === 'delete') {
            const k = parts[1];
            ops.push({ type: 'del', key: k });
          }
        }
        const db = await KVDB.open(dbPath);
        await db.batch(ops);
        db.close();
        break;
      }

      case 'dump': {
        const dbPath = args[1];
        if (!dbPath) throw new Error('Usage: kvdb dump <path>');
        const db = await KVDB.open(dbPath);
        const entries = await db.dump();
        db.close();
        for (const entry of entries) {
          console.log(`${entry.key} ${entry.value}`);
        }
        break;
      }

      case 'check': {
        const dbPath = args[1];
        if (!dbPath) throw new Error('Usage: kvdb check <path>');
        const db = await KVDB.open(dbPath);
        const result = await db.check();
        db.close();
        if (result.ok) {
          console.log('OK');
        } else {
          console.log(result.reason);
          process.exitCode = 1;
        }
        break;
      }

      case 'compact': {
        const dbPath = args[1];
        if (!dbPath) throw new Error('Usage: kvdb compact <path>');
        const db = await KVDB.open(dbPath);
        await db.compact();
        db.close();
        console.log('OK');
        break;
      }

      case 'serve': {
        const dbPath = args[1];
        if (!dbPath) throw new Error('Usage: kvdb serve <path> [--max-bytes N]');
        let maxBytes = 0;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--max-bytes' && args[i + 1]) {
            maxBytes = Number(args[i + 1]);
            i++;
          }
        }
        await runServer(dbPath, maxBytes);
        break;
      }

      default:
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

async function runServer(dbPath, maxBytes) {
  const db = await KVDB.open(dbPath, { maxBytes });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let pendingBatch = null; // { id, count, ops: [] }
  let autoOpId = 1;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Handle batch lines continuation if reading a multi-line batch
    if (pendingBatch) {
      const parts = trimmed.split(/\s+/);
      const subType = parts[0].toLowerCase();
      if (subType === 'put') {
        pendingBatch.ops.push({ type: 'put', key: parts[1], value: parts.slice(2).join(' ') });
      } else if (subType === 'del' || subType === 'delete') {
        pendingBatch.ops.push({ type: 'del', key: parts[1] });
      }

      if (pendingBatch.ops.length >= pendingBatch.count) {
        try {
          await db.batch(pendingBatch.ops);
          // Print ACK only after fsync completes!
          process.stdout.write(`ACK ${pendingBatch.id}\n`);
        } catch (err) {
          process.stdout.write(`ERR ${pendingBatch.id} ${err.message}\n`);
        }
        pendingBatch = null;
      }
      continue;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'exit' || cmd === 'quit') {
      break;
    }

    if (cmd === 'put') {
      // Syntax: "put <id> <key> <val>" OR "put <key> <val>"
      let opId;
      let key;
      let val;
      if (parts.length >= 4) {
        opId = parts[1];
        key = parts[2];
        val = parts.slice(3).join(' ');
      } else if (parts.length === 3) {
        opId = String(autoOpId++);
        key = parts[1];
        val = parts[2];
      } else {
        process.stdout.write(`ERR invalid put format\n`);
        continue;
      }

      try {
        await db.put(key, val);
        process.stdout.write(`ACK ${opId}\n`);
      } catch (err) {
        process.stdout.write(`ERR ${opId} ${err.message}\n`);
      }
    } else if (cmd === 'del' || cmd === 'delete') {
      // Syntax: "del <id> <key>" OR "del <key>"
      let opId;
      let key;
      if (parts.length >= 3) {
        opId = parts[1];
        key = parts[2];
      } else if (parts.length === 2) {
        opId = String(autoOpId++);
        key = parts[1];
      } else {
        process.stdout.write(`ERR invalid del format\n`);
        continue;
      }

      try {
        await db.delete(key);
        process.stdout.write(`ACK ${opId}\n`);
      } catch (err) {
        process.stdout.write(`ERR ${opId} ${err.message}\n`);
      }
    } else if (cmd === 'batch') {
      // Syntax 1: "batch <id> <count>" (followed by count lines)
      // Syntax 2: "batch <id> file <path>"
      // Syntax 3: "batch <file>"
      if (parts.length === 3 && !isNaN(Number(parts[2]))) {
        pendingBatch = {
          id: parts[1],
          count: Number(parts[2]),
          ops: [],
        };
        if (pendingBatch.count === 0) {
          process.stdout.write(`ACK ${pendingBatch.id}\n`);
          pendingBatch = null;
        }
      } else if (parts.length === 4 && parts[2].toLowerCase() === 'file') {
        const opId = parts[1];
        const filePath = parts[3];
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const ops = lines.map(l => {
            const p = l.split(/\s+/);
            return p[0].toLowerCase() === 'put'
              ? { type: 'put', key: p[1], value: p.slice(2).join(' ') }
              : { type: 'del', key: p[1] };
          });
          await db.batch(ops);
          process.stdout.write(`ACK ${opId}\n`);
        } catch (err) {
          process.stdout.write(`ERR ${opId} ${err.message}\n`);
        }
      } else if (parts.length === 2 && fs.existsSync(parts[1])) {
        const opId = String(autoOpId++);
        const filePath = parts[1];
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const ops = lines.map(l => {
            const p = l.split(/\s+/);
            return p[0].toLowerCase() === 'put'
              ? { type: 'put', key: p[1], value: p.slice(2).join(' ') }
              : { type: 'del', key: p[1] };
          });
          await db.batch(ops);
          process.stdout.write(`ACK ${opId}\n`);
        } catch (err) {
          process.stdout.write(`ERR ${opId} ${err.message}\n`);
        }
      } else {
        process.stdout.write(`ERR invalid batch format\n`);
      }
    } else if (cmd === 'compact') {
      const opId = parts[1] || String(autoOpId++);
      try {
        await db.compact();
        process.stdout.write(`ACK ${opId}\n`);
      } catch (err) {
        process.stdout.write(`ERR ${opId} ${err.message}\n`);
      }
    } else if (cmd === 'get') {
      const key = parts[1];
      const val = await db.get(key);
      if (val === null) {
        process.stdout.write(`NOTFOUND\n`);
      } else {
        process.stdout.write(`${val.toString('utf8')}\n`);
      }
    } else {
      process.stdout.write(`ERR unknown command: ${cmd}\n`);
    }
  }

  db.close();
}

function printUsage() {
  console.log(`KVDB Command Line Interface

Usage:
  ./kvdb open <path> [--max-bytes N]   Open or create, recover, print keys
  ./kvdb put <path> <key> <value>      Store key-value pair
  ./kvdb get <path> <key>              Retrieve value or NOTFOUND
  ./kvdb del <path> <key>              Delete key
  ./kvdb batch <path> <file>           Execute atomic batch from file
  ./kvdb dump <path>                   Dump sorted keys and values
  ./kvdb check <path>                  Verify file integrity (OK or reason)
  ./kvdb compact <path>                Shrink file by discarding old versions
  ./kvdb serve <path> [--max-bytes N]  Interactive persistent server mode
`);
}

main();
