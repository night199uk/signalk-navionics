'use strict';

const fs = require('fs');
const path = require('path');

class Trace {
  constructor(dir, label = 'sftp', enabled = true) {
    this.file = null;
    this.stream = null;
    if (!enabled) return;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '_');
    this.file = path.join(dir, `${safeLabel}-${stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', (err) => {
      console.error('trace stream error:', err.message);
    });
  }

  log(event) {
    if (!this.stream) return;
    this.stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

module.exports = { Trace };
