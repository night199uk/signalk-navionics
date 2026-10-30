'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const BURST_FILE = path.resolve(__dirname, '..', 'support', 'discovery-burst.json');
const OLD_IP = [192, 0, 2, 1]; // TEST-NET-1 placeholder in the stored burst

function ipBytes(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

function replaceAll(buf, from, to) {
  const chunks = [];
  let pos = 0;
  while (pos <= buf.length - from.length) {
    const at = buf.indexOf(from, pos);
    if (at === -1) break;
    chunks.push(buf.subarray(pos, at), to);
    pos = at + from.length;
  }
  chunks.push(buf.subarray(pos));
  return Buffer.concat(chunks);
}

function rewrite(payload, fakeIp) {
  const oldBe = Buffer.from(OLD_IP);
  const newBe = ipBytes(fakeIp);
  const oldLe = Buffer.from([...oldBe].reverse());
  const newLe = Buffer.from([...newBe].reverse());
  let out = Buffer.from(payload);
  out = replaceAll(out, oldBe, newBe);
  out = replaceAll(out, oldLe, newLe);
  return out;
}

class Discovery {
  constructor(options, trace) {
    this.fakeIp = options.fakeIp;
    this.dests = options.dests;
    this.intervalMs = options.intervalMs;
    this.trace = trace;
    this.burst = JSON.parse(fs.readFileSync(BURST_FILE, 'utf8')).packets;
    this.sockets = new Map();
    this.timers = new Set();
    this.interval = null;
    this.stopped = false;
  }

  async start() {
    if (this.interval) return;
    const sports = [...new Set(this.burst.map((p) => p.sport))];
    for (const sport of sports) {
      this.sockets.set(sport, await this.bindSocket(sport));
    }
    this.log({ op: 'discovery-start', source: this.fakeIp, dests: this.dests, intervalMs: this.intervalMs, packets: this.burst.length });
    this.fire();
    this.interval = setInterval(() => this.fire(), this.intervalMs);
  }

  bindSocket(sport) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const fail = (err) => {
        socket.close();
        reject(err);
      };
      socket.once('error', fail);
      socket.bind({ address: this.fakeIp, port: sport, exclusive: true }, () => {
        socket.removeListener('error', fail);
        socket.on('error', (err) => this.log({ op: 'discovery-error', sport, error: err.message }));
        socket.setBroadcast(true);
        try {
          if (this.fakeIp && this.fakeIp !== '0.0.0.0') {
            socket.setMulticastInterface(this.fakeIp);
          }
          socket.setMulticastTTL(1);
        } catch (err) {
          this.log({ op: 'discovery-multicast-error', sport, error: err.message });
        }
        resolve(socket);
      });
    });
  }

  fire() {
    if (this.stopped) return;
    const base = Date.now();
    for (const packet of this.burst) {
      const timer = setTimeout(() => this.send(packet), packet.offset_ms);
      this.timers.add(timer);
    }
  }

  send(packet) {
    const socket = this.sockets.get(packet.sport);
    if (!socket) return;
    const payload = rewrite(Buffer.from(packet.payload_b64, 'base64'), this.fakeIp);
    for (const dest of this.dests) {
      socket.send(payload, 5800, dest, (err) => {
        if (err) this.log({ op: 'discovery-send-error', dest, error: err.message });
      });
    }
  }

  log(event) {
    this.trace.log(event);
  }

  stop() {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets.values()) {
      try { socket.close(); } catch {}
    }
    this.sockets.clear();
    this.log({ op: 'discovery-stop' });
  }
}

module.exports = { Discovery };
