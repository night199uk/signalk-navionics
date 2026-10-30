'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils } = require('ssh2');

// The app's libssh2 client does not answer our server-side keepalives reliably.
// Let the TCP/SSH session stay idle instead of dropping it after 60s.
Server.KEEPALIVE_CLIENT_INTERVAL = 0;
const { Trace } = require('./trace');
const { SftpServer } = require('./sftp-server');
const { Discovery } = require('./discovery');

const PROJECT_DIR = path.resolve(__dirname, '..');

function localIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function loadAllowedKeys(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`authorized keys not found: ${file}`);
  }
  const keys = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let key = utils.parseKey(line);
    if (Array.isArray(key)) key = key[0];
    if (key instanceof Error) {
      console.warn(`ignoring unparsable authorized key: ${key.message}`);
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function keyAllowed(key, allowedKeys) {
  if (!key || !key.data) return false;
  return allowedKeys.some((allowed) => {
    try {
      return allowed.getPublicSSH().equals(key.data);
    } catch {
      return false;
    }
  });
}

async function start(options = {}) {
  const env = options.env || process.env;
  // In a Podman/Docker container we prefer port 22 so a bridge-network
  // container can be reached with PublishPort=22:22. Host-network containers
  // normally collide with the host sshd, so fall back to 2222 below.
  const isContainer = env.CONTAINER === '1'
    || env.container === 'podman'
    || fs.existsSync('/run/.containerenv')
    || fs.existsSync('/.dockerenv');
  const preferredPort = Number(env.SSH_PORT || (isContainer ? 22 : 2222));
  const bind = env.SSH_BIND || '0.0.0.0';
  const user = env.SSH_USER || 'media_rw';
  // The plugin supports exactly one mounted Navionics card.
  const cardRoot = path.resolve(env.CARD_ROOT || '/mnt/internal_slot1');
  const slotPath = env.SLOT_PATH || cardRoot;
  const traceDir = path.resolve(env.TRACE_DIR || path.join(PROJECT_DIR, 'traces'));
  const sessionTraceDir = path.resolve(env.SESSION_TRACE_DIR || path.join(traceDir, 'sessions'));
  const traceEnabled = env.TRACE_ENABLED === '1';
  const hostRsa = env.HOST_RSA ? path.resolve(env.HOST_RSA) : '';
  const hostEd25519 = env.HOST_ED25519 ? path.resolve(env.HOST_ED25519) : '';
  const authorizedKeys = path.resolve(env.AUTHORIZED_KEYS || path.join(PROJECT_DIR, 'keys/authorized_keys'));
  // Must be the secondary address used for discovery; the app connects to the
  // UDP source address on TCP 22, which is why the host SSH daemon cannot own
  // that address/port combination.
  const configuredIp = env.FAKE_IP || '192.168.1.250';
  const fakeIp = configuredIp === '0.0.0.0' ? localIPv4() : configuredIp;
  if (!fakeIp) throw new Error('cannot determine the discovery source address');
  const discoveryDests = ['224.0.0.1'];
  const discoveryIntervalMs = 1000;

  if (!fs.existsSync(cardRoot)) {
    throw new Error(`card root does not exist: ${cardRoot}`);
  }
  for (const [name, key] of [['HOST_RSA', hostRsa], ['HOST_ED25519', hostEd25519]]) {
    if (!key || !fs.existsSync(key)) throw new Error(`${name} is not configured: ${key || '(empty)'}`);
  }

  const allowedKeys = loadAllowedKeys(authorizedKeys);
  const trace = new Trace(traceDir, 'server', traceEnabled);
  let discovery = null;
  let closing = false;

  const server = new Server(
    {
      ident: 'SSH-2.0-OpenSSH_10.0',
      hostKeys: [fs.readFileSync(hostRsa), fs.readFileSync(hostEd25519)],
      algorithms: {
        serverHostKey: ['ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa'],
      },
    },
    (client, info) => {
      const remote = info && info.ip ? `${info.ip}:${info.port}` : 'unknown';
      trace.log({ op: 'connection', remote });
      console.log(`connection from ${remote}`);
      try {
        client._sock.setKeepAlive(true, 15000);
        client._sock.setNoDelay(true);
      } catch {}

      client.on('greeting', (greeting) => {
        trace.log({ op: 'greeting', remote, greeting });
        console.log(`greeting ${remote}: ${greeting}`);
      });

      client.on('handshake', (neg) => {
        trace.log({
          op: 'handshake',
          remote,
          kex: neg && neg.kex,
          hostKey: neg && neg.srvHostKey,
          cs: neg && neg.cs,
          sc: neg && neg.sc,
        });
        console.log(`handshake ${remote}: ${neg && neg.kex} / ${neg && neg.srvHostKey}`);
      });

      client.on('authentication', (ctx) => {
        const event = {
          op: 'auth',
          remote,
          username: ctx.username,
          method: ctx.method,
          algo: ctx.key && ctx.key.algo,
          signed: Boolean(ctx.signature),
        };
        if (ctx.username !== user) {
          trace.log({ ...event, status: 'bad-user' });
          return ctx.reject(['publickey']);
        }
        if (ctx.method !== 'publickey') {
          trace.log({ ...event, status: 'reject-method' });
          return ctx.reject(['publickey']);
        }
        if (!keyAllowed(ctx.key, allowedKeys)) {
          trace.log({ ...event, status: 'bad-key' });
          return ctx.reject(['publickey']);
        }
        trace.log({ ...event, status: ctx.signature ? 'accept' : 'key-ok' });
        ctx.accept();
      });

      client.on('ready', () => {
        trace.log({ op: 'ready', remote });
        console.log(`authenticated ${remote}`);
      });

      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const sessionTrace = new Trace(
            sessionTraceDir,
            `session-${remote}-${Date.now()}`,
            traceEnabled,
          );
          sessionTrace.log({
            op: 'session-start',
            remote,
            cardRoot,
            slot: slotPath,
          });
          trace.log({ op: 'sftp-session', remote, sessionTrace: sessionTrace.file });
          console.log(`SFTP session ${remote} -> ${sessionTrace.file}`);
          new SftpServer(sftp, {
            root: cardRoot,
            slot: slotPath,
          }, sessionTrace).attach();
        });
      });

      client.on('close', () => {
        trace.log({ op: 'disconnect', remote });
        console.log(`disconnect ${remote}`);
      });

      client.on('error', (err) => {
        trace.log({ op: 'client-error', remote, error: err.message });
        console.error(`client error ${remote}: ${err.message}`);
      });
    },
  );

  server.on('error', (err) => {
    // Port selection handles these; log only unexpected server errors.
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') return;
    trace.log({ op: 'server-error', error: err.message });
    console.error('server error:', err);
  });

  const listenOn = (portToTry) => new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(portToTry, bind);
  });

  let actualPort = preferredPort;
  try {
    await listenOn(actualPort);
  } catch (err) {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && actualPort !== 2222) {
      console.warn(`Cannot bind TCP ${actualPort} (${err.code}); falling back to 2222`);
      trace.log({ op: 'port-fallback', from: actualPort, to: 2222, error: err.message });
      actualPort = 2222;
      await listenOn(actualPort);
    } else {
      throw err;
    }
  }
  actualPort = server.address() && typeof server.address() === 'object'
    ? server.address().port
    : actualPort;
  console.log(`SSH/SFTP server listening on ${bind}:${actualPort}`);
  console.log(`  user: ${user}`);
  console.log(`  card root: ${cardRoot}`);
  if (traceEnabled) console.log(`  trace: ${trace.file}`);
  trace.log({
    op: 'listen',
    bind,
    port: actualPort,
    user,
    cardRoot,
    slot: slotPath,
  });

  discovery = new Discovery({
    fakeIp,
    dests: discoveryDests,
    intervalMs: discoveryIntervalMs,
  }, trace);
  discovery.start().catch((err) => {
    trace.log({ op: 'discovery-failed', error: err.message });
    console.error('discovery failed:', err.message);
  });

  const close = () => {
    if (closing) return;
    closing = true;
    trace.log({ op: 'shutdown' });
    if (discovery) discovery.stop();
    server.close(() => trace.close());
    setTimeout(() => trace.close(), 1000).unref();
  };

  return { server, trace, close, port: actualPort, bind };
}

module.exports = { start };
