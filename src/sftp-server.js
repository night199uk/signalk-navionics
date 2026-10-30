'use strict';

const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');

const { STATUS_CODE, flagsToString } = utils.sftp;

const STATUS_NAME = Object.fromEntries(
  Object.entries(STATUS_CODE).map(([name, code]) => [code, name]),
);

function statusFor(err) {
  switch (err && err.code) {
    case 'ENOENT':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

function modeString(mode) {
  const type = (mode & 0o170000) === 0o040000
    ? 'd'
    : (mode & 0o170000) === 0o120000
      ? 'l'
      : '-';
  const bits = ['r', 'w', 'x'];
  let perms = '';
  for (let bit = 8; bit >= 0; --bit) {
    perms += (mode & (1 << bit)) ? bits[(8 - bit) % 3] : '-';
  }
  return type + perms;
}

function longname(name, st) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(st.mtimeMs);
  const date = `${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${modeString(st.mode)} ${String(st.nlink).padStart(3)} ${st.uid} ${st.gid} `
    + `${String(st.size).padStart(8)} ${date} ${name}`;
}

function attrsFromStats(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

class SftpServer {
  constructor(sftp, options, trace) {
    this.sftp = sftp;
    this.root = path.resolve(options.root);
    this.slot = options.slot;
    this.trace = trace;
    this.handles = new Map();
    this.nextHandle = 1;
  }

  attach() {
    const s = this.sftp;
    s.on('OPEN', (id, filename, flags, attrs) => this.open(id, filename, flags, attrs));
    s.on('READ', (id, handle, offset, length) => this.read(id, handle, offset, length));
    s.on('WRITE', (id, handle, offset, data) => this.write(id, handle, offset, data));
    s.on('CLOSE', (id, handle) => this.close(id, handle));
    s.on('FSTAT', (id, handle) => this.fstat(id, handle));
    s.on('FSETSTAT', (id, handle, attrs) => this.fsetstat(id, handle, attrs));
    s.on('OPENDIR', (id, filename) => this.opendir(id, filename));
    s.on('READDIR', (id, handle) => this.readdir(id, handle));
    s.on('LSTAT', (id, filename) => this.stat(id, filename, true));
    s.on('STAT', (id, filename) => this.stat(id, filename, false));
    s.on('REMOVE', (id, filename) => this.remove(id, filename));
    s.on('RMDIR', (id, filename) => this.rmdir(id, filename));
    s.on('MKDIR', (id, filename, attrs) => this.mkdir(id, filename, attrs));
    s.on('RENAME', (id, oldPath, newPath) => this.rename(id, oldPath, newPath));
    s.on('REALPATH', (id, filename) => this.realpath(id, filename));
    s.on('READLINK', (id, filename) => this.unsupported(id, 'READLINK', filename));
    s.on('SYMLINK', (id, linkPath, targetPath) => this.unsupported(id, 'SYMLINK', linkPath, targetPath));
    s.on('EXTENDED', (id, extended) => this.unsupported(id, 'EXTENDED', extended));
    s.on('error', (err) => this.log({ op: 'sftp-error', error: err.message }));
    s.on('end', () => {
      this.log({ op: 'sftp-end' });
      this.trace.close();
    });
    s.on('close', () => this.trace.close());
  }

  log(event) {
    this.trace.log(event);
  }

  respond(id, op, extra = {}) {
    this.log({ op, id, status: 'OK', ...extra });
    this.sftp.status(id, STATUS_CODE.OK);
  }

  fail(id, op, err, extra = {}) {
    const code = statusFor(err);
    this.log({
      op,
      id,
      status: STATUS_NAME[code] || code,
      error: err.message,
      ...extra,
    });
    this.sftp.status(id, code, err.message);
  }

  resolve(input) {
    const raw = input == null ? '.' : String(input);
    const norm = path.posix.normalize(raw);
    if (norm === '.' || norm === './') {
      return { virtual: '.', real: this.root };
    }
    if (norm === '/') {
      return { virtual: '/', real: this.root };
    }
    if (norm === this.slot || norm.startsWith(`${this.slot}/`)) {
      const rel = norm.slice(this.slot.length).replace(/^\/+/, '');
      const real = path.resolve(this.root, rel);
      if (real !== this.root && !real.startsWith(`${this.root}${path.sep}`)) {
        const err = new Error('path escapes card root');
        err.code = 'EACCES';
        throw err;
      }
      return { virtual: norm, real };
    }
    const err = new Error(`No such file: ${raw}`);
    err.code = 'ENOENT';
    throw err;
  }

  newHandle(kind, data) {
    const id = this.nextHandle++;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id, 0);
    this.handles.set(id, { kind, ...data });
    return handle;
  }

  getHandle(handle) {
    if (!Buffer.isBuffer(handle) || handle.length < 4) return null;
    return this.handles.get(handle.readUInt32BE(0));
  }

  handleId(handle) {
    return Buffer.isBuffer(handle) && handle.length >= 4 ? handle.readUInt32BE(0) : null;
  }

  entriesFor(real) {
    const entries = [];
    const add = (filename, p) => {
      try {
        const st = fs.statSync(p);
        entries.push({ filename, longname: longname(filename, st), attrs: attrsFromStats(st) });
      } catch {
        // ignore unreadable entries
      }
    };
    add('.', real);
    add('..', path.dirname(real));
    for (const ent of fs.readdirSync(real, { withFileTypes: true })) {
      add(ent.name, path.join(real, ent.name));
    }
    return entries;
  }

  async open(id, filename, flags, attrs) {
    let target;
    try {
      target = this.resolve(filename);
      const flagsStr = flagsToString(flags);
      if (!flagsStr) throw Object.assign(new Error(`bad open flags ${flags}`), { code: 'EINVAL' });
      const mode = attrs && attrs.mode != null ? attrs.mode & 0o777 : 0o666;
      const fd = fs.openSync(target.real, flagsStr, mode);
      const handle = this.newHandle('file', {
        fd,
        real: target.real,
        virtual: target.virtual,
      });
      this.log({ op: 'open', id, path: target.virtual, flags: flagsStr, mode, handle: this.handleId(handle), status: 'OK' });
      this.sftp.handle(id, handle);
    } catch (err) {
      this.fail(id, 'open', err, { path: filename, flags });
    }
  }

  async read(id, handle, offset, length) {
    const h = this.getHandle(handle);
    if (!h || h.kind !== 'file') {
      return this.fail(id, 'read', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    try {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(h.fd, buf, 0, length, offset);
      if (n === 0) {
        this.log({ op: 'read', id, path: h.virtual, offset, length, bytes: 0, status: 'EOF' });
        return this.sftp.status(id, STATUS_CODE.EOF);
      }
      this.log({ op: 'read', id, path: h.virtual, offset, length, bytes: n, status: 'OK' });
      this.sftp.data(id, buf.subarray(0, n));
    } catch (err) {
      this.fail(id, 'read', err, { path: h.virtual, offset, length });
    }
  }

  async write(id, handle, offset, data) {
    const h = this.getHandle(handle);
    if (!h || h.kind !== 'file') {
      return this.fail(id, 'write', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    try {
      const n = fs.writeSync(h.fd, data, 0, data.length, offset);
      this.log({ op: 'write', id, path: h.virtual, offset, length: data.length, bytes: n, status: 'OK' });
      this.sftp.status(id, STATUS_CODE.OK);
    } catch (err) {
      this.fail(id, 'write', err, { path: h.virtual, offset, length: data.length });
    }
  }

  async close(id, handle) {
    const h = this.getHandle(handle);
    if (!h) {
      return this.fail(id, 'close', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    try {
      if (h.kind === 'file') fs.closeSync(h.fd);
      this.handles.delete(this.handleId(handle));
      this.respond(id, 'close', { path: h.virtual, handle: this.handleId(handle) });
    } catch (err) {
      this.handles.delete(this.handleId(handle));
      this.fail(id, 'close', err, { path: h.virtual });
    }
  }

  async fstat(id, handle) {
    const h = this.getHandle(handle);
    if (!h) {
      return this.fail(id, 'fstat', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    try {
      const st = h.kind === 'file' ? fs.fstatSync(h.fd) : fs.statSync(h.real);
      this.log({ op: 'fstat', id, path: h.virtual, status: 'OK' });
      this.sftp.attrs(id, attrsFromStats(st));
    } catch (err) {
      this.fail(id, 'fstat', err, { path: h.virtual });
    }
  }

  applyAttrs(real, attrs) {
    if (!attrs) return;
    if (attrs.mode != null) {
      try {
        fs.chmodSync(real, attrs.mode & 0o777);
      } catch (err) {
        if (err.code !== 'EPERM') throw err;
      }
    }
    if (attrs.size != null) fs.truncateSync(real, attrs.size);
    if (attrs.atime != null || attrs.mtime != null) {
      const atime = attrs.atime != null ? new Date(attrs.atime * 1000) : new Date();
      const mtime = attrs.mtime != null ? new Date(attrs.mtime * 1000) : new Date();
      fs.utimesSync(real, atime, mtime);
    }
  }

  applyFAttrs(h, attrs) {
    if (!attrs) return;
    if (attrs.mode != null) {
      try {
        fs.fchmodSync(h.fd, attrs.mode & 0o777);
      } catch (err) {
        if (err.code !== 'EPERM') throw err;
      }
    }
    if (attrs.size != null) fs.ftruncateSync(h.fd, attrs.size);
    if (attrs.atime != null || attrs.mtime != null) {
      const atime = attrs.atime != null ? new Date(attrs.atime * 1000) : new Date();
      const mtime = attrs.mtime != null ? new Date(attrs.mtime * 1000) : new Date();
      fs.futimesSync(h.fd, atime, mtime);
    }
  }

  async fsetstat(id, handle, attrs) {
    const h = this.getHandle(handle);
    if (!h || h.kind !== 'file') {
      return this.fail(id, 'fsetstat', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    try {
      this.applyFAttrs(h, attrs);
      this.respond(id, 'fsetstat', { path: h.virtual });
    } catch (err) {
      this.fail(id, 'fsetstat', err, { path: h.virtual });
    }
  }

  async opendir(id, filename) {
    try {
      const target = this.resolve(filename);
      const st = fs.statSync(target.real);
      if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      const entries = this.entriesFor(target.real);
      const handle = this.newHandle('dir', {
        real: target.real,
        virtual: target.virtual,
        entries,
        done: false,
      });
      this.log({ op: 'opendir', id, path: target.virtual, entries: entries.length, handle: this.handleId(handle), status: 'OK' });
      this.sftp.handle(id, handle);
    } catch (err) {
      this.fail(id, 'opendir', err, { path: filename });
    }
  }

  readdir(id, handle) {
    const h = this.getHandle(handle);
    if (!h || h.kind !== 'dir') {
      return this.fail(id, 'readdir', Object.assign(new Error('invalid handle'), { code: 'EBADF' }), { handle: this.handleId(handle) });
    }
    if (h.done) {
      this.log({ op: 'readdir', id, path: h.virtual, names: 0, status: 'EOF' });
      return this.sftp.status(id, STATUS_CODE.EOF);
    }
    h.done = true;
    this.log({ op: 'readdir', id, path: h.virtual, names: h.entries.length, status: 'OK' });
    this.sftp.name(id, h.entries);
  }

  async stat(id, filename, lstat) {
    try {
      const target = this.resolve(filename);
      const st = lstat ? fs.lstatSync(target.real) : fs.statSync(target.real);
      this.log({ op: lstat ? 'lstat' : 'stat', id, path: target.virtual, status: 'OK' });
      this.sftp.attrs(id, attrsFromStats(st));
    } catch (err) {
      this.fail(id, lstat ? 'lstat' : 'stat', err, { path: filename });
    }
  }

  async remove(id, filename) {
    try {
      const target = this.resolve(filename);
      fs.unlinkSync(target.real);
      this.respond(id, 'remove', { path: target.virtual });
    } catch (err) {
      this.fail(id, 'remove', err, { path: filename });
    }
  }

  async rmdir(id, filename) {
    try {
      const target = this.resolve(filename);
      fs.rmdirSync(target.real);
      this.respond(id, 'rmdir', { path: target.virtual });
    } catch (err) {
      this.fail(id, 'rmdir', err, { path: filename });
    }
  }

  async mkdir(id, filename, attrs) {
    try {
      const target = this.resolve(filename);
      const mode = attrs && attrs.mode != null ? attrs.mode & 0o777 : 0o755;
      fs.mkdirSync(target.real, { mode });
      this.respond(id, 'mkdir', { path: target.virtual, mode });
    } catch (err) {
      this.fail(id, 'mkdir', err, { path: filename });
    }
  }

  async rename(id, oldPath, newPath) {
    try {
      const from = this.resolve(oldPath);
      const to = this.resolve(newPath);
      fs.renameSync(from.real, to.real);
      this.respond(id, 'rename', { path: from.virtual, path2: to.virtual });
    } catch (err) {
      this.fail(id, 'rename', err, { path: oldPath, path2: newPath });
    }
  }

  realpath(id, filename) {
    try {
      const target = this.resolve(filename);
      const virtual = target.virtual === '.' ? '.' : target.virtual;
      this.log({ op: 'realpath', id, path: virtual, status: 'OK' });
      this.sftp.name(id, [{ filename: virtual, longname: virtual, attrs: {} }]);
    } catch (err) {
      this.fail(id, 'realpath', err, { path: filename });
    }
  }

  unsupported(id, op, ...args) {
    this.log({ op, id, args, status: 'OP_UNSUPPORTED' });
    this.sftp.status(id, STATUS_CODE.OP_UNSUPPORTED);
  }
}

module.exports = { SftpServer };
