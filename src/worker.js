'use strict';

const { parentPort, workerData } = require('worker_threads');
const { start } = require('./server');

if (!parentPort) {
  console.error('worker.js must be run as a Worker');
  process.exit(1);
}
Object.assign(process.env, (workerData && workerData.env) || {});

let runtime = null;
let stopped = false;

start()
  .then((value) => {
    runtime = value;
    parentPort.postMessage({ type: 'navionics-ready', port: value.port, bind: value.bind });
  })
  .catch((err) => {
    console.error(`Navionics worker failed: ${err.message}`);
    parentPort.postMessage({
      type: 'navionics-error',
      error: { message: err.message, code: err.code },
    });
  });

parentPort.on('message', (message) => {
  if (!message || message.type !== 'navionics-shutdown' || stopped) return;
  stopped = true;
  if (runtime) runtime.close();
});

process.on('uncaughtException', (err) => {
  console.error(`Navionics worker uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  console.error(`Navionics worker unhandled rejection: ${err && (err.stack || err.message)}`);
});
