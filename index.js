'use strict';

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');
const { CardResourceProvider } = require('./src/card-resources');

const PLUGIN_DIR = __dirname;
const WORKER = path.join(PLUGIN_DIR, 'src', 'worker.js');
const AUTHORIZED_KEYS = path.join(PLUGIN_DIR, 'keys', 'authorized_keys');
const OPENSSL_CONF = path.join(PLUGIN_DIR, 'support', 'openssl-sha1.cnf');

// The plugin supports exactly one mounted Navionics card.
const CARD_ROOT = '/mnt/internal_slot1';
// The Navionics app connects to the source address of the UDP discovery burst
// on TCP 22. This must be a secondary address on the Signal K host because the
// host SSH daemon already owns TCP 22. The host needs:
//   192.168.1.250/24 on the LAN interface
//   192.168.1.250:22 -> 192.168.1.250:2222
const DEFAULT_BIND_IP = '192.168.1.250';

const DEFAULTS = {
  cardRoot: CARD_ROOT,
  bindIp: DEFAULT_BIND_IP,
};

function logDebug(app, message) {
  if (app && typeof app.debug === 'function') app.debug(message);
  else console.log(message);
}

function logError(app, message) {
  if (app && typeof app.error === 'function') app.error(message);
  else console.error(message);
}

function ensureKey(file, type, options) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = utils.generateKeyPairSync(type, options);
  fs.writeFileSync(file, key.private, { mode: 0o600 });
}

module.exports = function plugin(app) {
  let worker = null;
  let cardProvider = null;
  let starting = false;
  let stopping = false;

  function setStatus(message) {
    if (typeof app.setPluginStatus === 'function') app.setPluginStatus(message);
  }

  function setError(message) {
    if (typeof app.setPluginError === 'function') app.setPluginError(message);
  }

  function stopWorker() {
    if (!worker) return;
    const current = worker;
    worker = null;
    try {
      current.postMessage({ type: 'navionics-shutdown' });
    } catch {}
    setTimeout(() => {
      current.terminate().catch(() => {});
    }, 1000).unref();
  }

  function registerCardResources(cfg) {
    if (cardProvider) return;
    if (typeof app.registerResourceProvider !== 'function') {
      throw new Error('Signal K resource providers are not available');
    }
    cardProvider = new CardResourceProvider({
      cardRoot: cfg.cardRoot,
      source: 'signalk-navionics',
      log: (message) => logDebug(app, `[navionics] ${message}`),
    });
    cardProvider.register(app);
  }

  async function launch(cfg, dataDir) {
    const traceDir = path.join(dataDir, 'traces');
    const hostRsa = path.join(dataDir, 'host_rsa');
    const hostEd25519 = path.join(dataDir, 'host_ed25519');
    const traceEnabled = Boolean(app.debug && app.debug.enabled);
    ensureKey(hostRsa, 'rsa', { bits: 3072 });
    ensureKey(hostEd25519, 'ed25519');
    if (traceEnabled) {
      fs.mkdirSync(path.join(traceDir, 'sessions'), {
        recursive: true,
        mode: 0o700,
      });
    }

    if (stopping) return;

    const env = {
      ...process.env,
      OPENSSL_CONF,
      CARD_ROOT: cfg.cardRoot,
      SLOT_PATH: cfg.cardRoot,
      SSH_BIND: cfg.bindIp,
      SSH_USER: 'media_rw',
      AUTHORIZED_KEYS,
      HOST_RSA: hostRsa,
      HOST_ED25519: hostEd25519,
      TRACE_DIR: traceDir,
      SESSION_TRACE_DIR: path.join(traceDir, 'sessions'),
      TRACE_ENABLED: traceEnabled ? '1' : '0',
      FAKE_IP: cfg.bindIp,
    };

    worker = new Worker(WORKER, {
      workerData: { env },
      stdout: true,
      stderr: true,
    });
    const current = worker;

    current.stdout.on('data', (data) => logDebug(app, `[navionics] ${String(data).trim()}`));
    current.stderr.on('data', (data) => logError(app, `[navionics] ${String(data).trim()}`));

    current.on('message', (message) => {
      if (!message) return;
      if (message.type === 'navionics-ready') {
        const port = message.port || 2222;
        setStatus(`SFTP :${port} on ${cfg.bindIp}; card ${cfg.cardRoot}`);
      } else if (message.type === 'navionics-error') {
        const text = message.error && message.error.message ? message.error.message : 'worker failed';
        setError(text);
      }
    });

    current.on('error', (err) => {
      logError(app, `[navionics] worker error: ${err.message}`);
      setError(err.message);
    });

    current.on('exit', (code) => {
      if (worker === current) worker = null;
      if (!stopping) {
        const message = `SFTP worker exited (code=${code})`;
        logError(app, message);
        setError(message);
      }
    });

    setStatus(`Starting SFTP on ${cfg.bindIp}; card ${cfg.cardRoot}`);
    logDebug(app, 'Starting Navionics worker');
  }

  return {
    id: 'signalk-navionics',
    name: 'Navionics Plotter Sync',
    description:
      'Raymarine/Navionics discovery, a card-backed SFTP bridge, and read-only card resources in Signal K.',

    schema: {
      type: 'object',
      properties: {
        cardRoot: {
          type: 'string',
          title: 'Path to Navionics SD-card',
          default: DEFAULTS.cardRoot,
        },
        bindIp: {
          type: 'string',
          title: 'IP address to bind SSH server to (see README.md)',
          default: DEFAULTS.bindIp,
        },
      },
    },

    start(options) {
      if (worker || starting) {
        logDebug(app, 'Navionics Plotter Sync already running');
        return;
      }
      const cfg = { ...DEFAULTS, ...(options || {}) };
      if (!fs.existsSync(cfg.cardRoot)) {
        const message = `Navionics card path not found: ${cfg.cardRoot}`;
        logError(app, message);
        setError(message);
        return;
      }
      try {
        registerCardResources(cfg);
      } catch (err) {
        logError(app, `[navionics] resource provider failed: ${err.message}`);
        setError(err.message);
        return;
      }
      starting = true;
      stopping = false;
      launch(cfg, app.getDataDirPath()).catch((err) => {
        logError(app, `[navionics] start failed: ${err.message}`);
        setError(err.message);
      }).finally(() => {
        starting = false;
      });
    },

    stop() {
      stopping = true;
      logDebug(app, 'Stopping Navionics Plotter Sync');
      stopWorker();
      cardProvider = null;
      setStatus('Stopped');
    },
  };
};
