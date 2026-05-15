/**
 * sandbox-fs-hooks.js — Monkey-patches for fs and fs/promises operations.
 *
 * Enforces read/write blocking via sandbox-permission.js.
 * Covers: write ops (writeFile, appendFile, copyFile, rename, unlink, mkdir,
 * rmdir, rm, open, createWriteStream, truncate, symlink, link, chmod, cp),
 * read ops (readFile, readdir, createReadStream, stat, lstat, access),
 * and their sync + promise counterparts.
 */
"use strict";

var path = require("path");

function install(fsMod) {
  var S = require(path.join(__dirname, "sandbox-state.js"));
  var perm = require(path.join(__dirname, "sandbox-permission.js"));
  var sensitive = require(path.join(__dirname, "sandbox-sensitive.js"));
  var throwReadOnly = S.throwReadOnly;
  var throwReadBlocked = S.throwReadBlocked;
  var _shouldBlockWrite = perm.shouldBlockWrite;
  var _shouldBlockRead = perm.shouldBlockRead;
  var isSensitivePath = sensitive.isSensitivePath;
  var throwSensitiveDenied = sensitive.throwSensitiveDenied;

  // Wrap shouldBlockWrite/Read to pre-check sensitive paths.
  // Sensitive paths are always blocked with a distinct error, before
  // the normal permission logic runs. This keeps all existing hooks
  // unchanged — they just call shouldBlockWrite/shouldBlockRead as before.
  function shouldBlockWrite(filePath) {
    if (isSensitivePath(filePath)) return true;
    return _shouldBlockWrite(filePath);
  }
  function shouldBlockRead(filePath, shellContext) {
    if (isSensitivePath(filePath)) return true;
    return _shouldBlockRead(filePath, shellContext);
  }
  // Override throwReadOnly/throwReadBlocked to produce sensitive-specific errors
  var _throwReadOnly = throwReadOnly;
  var _throwReadBlocked = throwReadBlocked;
  throwReadOnly = function (filePath) {
    if (isSensitivePath(filePath)) return throwSensitiveDenied(filePath);
    return _throwReadOnly(filePath);
  };
  throwReadBlocked = function (filePath) {
    if (isSensitivePath(filePath)) return throwSensitiveDenied(filePath);
    return _throwReadBlocked(filePath);
  };

  // Helper: get callback from variable-arity args
  function getCb2(a, b) {
    return typeof a === "function" ? a : b;
  }

  // ── Write operations ──────────────────────────────────────────────────

  var _writeFileSync = fsMod.writeFileSync;
  fsMod.writeFileSync = function (file) {
    S.state._currentCmdPreview = 'fs.writeFileSync("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _writeFileSync.apply(this, arguments);
  };

  var _writeFile = fsMod.writeFile;
  fsMod.writeFile = function (file, data, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.writeFile("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadOnly(file));
        return;
      }
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _writeFile.apply(this, arguments);
  };

  var _appendFileSync = fsMod.appendFileSync;
  fsMod.appendFileSync = function (file) {
    S.state._currentCmdPreview = 'fs.appendFileSync("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _appendFileSync.apply(this, arguments);
  };

  var _appendFile = fsMod.appendFile;
  fsMod.appendFile = function (file, data, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.appendFile("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadOnly(file));
        return;
      }
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _appendFile.apply(this, arguments);
  };

  var _copyFileSync = fsMod.copyFileSync;
  fsMod.copyFileSync = function (src, dest) {
    S.state._currentCmdPreview = 'fs.copyFileSync("' + src + '", "' + dest + '")';
    if (shouldBlockWrite(dest)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(dest);
    }
    S.state._currentCmdPreview = null;
    return _copyFileSync.apply(this, arguments);
  };

  var _copyFile = fsMod.copyFile;
  fsMod.copyFile = function (src, dest, flagsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.copyFile("' + src + '", "' + dest + '")';
    if (shouldBlockWrite(dest)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(flagsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadOnly(dest));
        return;
      }
      throw throwReadOnly(dest);
    }
    S.state._currentCmdPreview = null;
    return _copyFile.apply(this, arguments);
  };

  var _renameSync = fsMod.renameSync;
  fsMod.renameSync = function (oldPath, newPath) {
    S.state._currentCmdPreview = 'fs.renameSync("' + oldPath + '", "' + newPath + '")';
    if (shouldBlockWrite(oldPath)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(oldPath);
    }
    if (shouldBlockWrite(newPath)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(newPath);
    }
    S.state._currentCmdPreview = null;
    return _renameSync.apply(this, arguments);
  };

  var _rename = fsMod.rename;
  fsMod.rename = function (oldPath, newPath, cb) {
    S.state._currentCmdPreview = 'fs.rename("' + oldPath + '", "' + newPath + '")';
    if (shouldBlockWrite(oldPath) || shouldBlockWrite(newPath)) {
      S.state._currentCmdPreview = null;
      var target = shouldBlockWrite(oldPath) ? oldPath : newPath;
      if (typeof cb === "function") {
        cb(throwReadOnly(target));
        return;
      }
      throw throwReadOnly(target);
    }
    S.state._currentCmdPreview = null;
    return _rename.apply(this, arguments);
  };

  var _unlinkSync = fsMod.unlinkSync;
  fsMod.unlinkSync = function (file) {
    S.state._currentCmdPreview = 'fs.unlinkSync("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _unlinkSync.apply(this, arguments);
  };

  var _unlink = fsMod.unlink;
  fsMod.unlink = function (file, cb) {
    S.state._currentCmdPreview = 'fs.unlink("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      if (typeof cb === "function") {
        cb(throwReadOnly(file));
        return;
      }
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _unlink.apply(this, arguments);
  };

  var _mkdirSync = fsMod.mkdirSync;
  fsMod.mkdirSync = function (dir) {
    S.state._currentCmdPreview = 'fs.mkdirSync("' + dir + '")';
    if (shouldBlockWrite(dir)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(dir);
    }
    S.state._currentCmdPreview = null;
    return _mkdirSync.apply(this, arguments);
  };

  var _mkdir = fsMod.mkdir;
  fsMod.mkdir = function (dir, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.mkdir("' + dir + '")';
    if (shouldBlockWrite(dir)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadOnly(dir));
        return;
      }
      throw throwReadOnly(dir);
    }
    S.state._currentCmdPreview = null;
    return _mkdir.apply(this, arguments);
  };

  var _rmdirSync = fsMod.rmdirSync;
  fsMod.rmdirSync = function (dir) {
    S.state._currentCmdPreview = 'fs.rmdirSync("' + dir + '")';
    if (shouldBlockWrite(dir)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(dir);
    }
    S.state._currentCmdPreview = null;
    return _rmdirSync.apply(this, arguments);
  };

  var _rmdir = fsMod.rmdir;
  fsMod.rmdir = function (dir, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.rmdir("' + dir + '")';
    if (shouldBlockWrite(dir)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadOnly(dir));
        return;
      }
      throw throwReadOnly(dir);
    }
    S.state._currentCmdPreview = null;
    return _rmdir.apply(this, arguments);
  };

  if (fsMod.rmSync) {
    var _rmSync = fsMod.rmSync;
    fsMod.rmSync = function (p) {
      S.state._currentCmdPreview = 'fs.rmSync("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _rmSync.apply(this, arguments);
    };
  }

  if (fsMod.rm) {
    var _rm = fsMod.rm;
    fsMod.rm = function (p, optsOrCb, cb) {
      S.state._currentCmdPreview = 'fs.rm("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(optsOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadOnly(p));
          return;
        }
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _rm.apply(this, arguments);
    };
  }

  // ── NEW: truncate ──

  if (fsMod.truncateSync) {
    var _truncateSync = fsMod.truncateSync;
    fsMod.truncateSync = function (p) {
      S.state._currentCmdPreview = 'fs.truncateSync("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _truncateSync.apply(this, arguments);
    };
  }

  if (fsMod.truncate) {
    var _truncate = fsMod.truncate;
    fsMod.truncate = function (p, lenOrCb, cb) {
      S.state._currentCmdPreview = 'fs.truncate("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(lenOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadOnly(p));
          return;
        }
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _truncate.apply(this, arguments);
    };
  }

  // ── NEW: symlink ──

  if (fsMod.symlinkSync) {
    var _symlinkSync = fsMod.symlinkSync;
    fsMod.symlinkSync = function (target, p) {
      S.state._currentCmdPreview = 'fs.symlinkSync("' + target + '", "' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _symlinkSync.apply(this, arguments);
    };
  }

  if (fsMod.symlink) {
    var _symlink = fsMod.symlink;
    fsMod.symlink = function (target, p, typeOrCb, cb) {
      S.state._currentCmdPreview = 'fs.symlink("' + target + '", "' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(typeOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadOnly(p));
          return;
        }
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _symlink.apply(this, arguments);
    };
  }

  // ── NEW: link (hard link) ──

  if (fsMod.linkSync) {
    var _linkSync = fsMod.linkSync;
    fsMod.linkSync = function (existingPath, newPath) {
      S.state._currentCmdPreview = 'fs.linkSync("' + existingPath + '", "' + newPath + '")';
      if (shouldBlockWrite(newPath)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(newPath);
      }
      S.state._currentCmdPreview = null;
      return _linkSync.apply(this, arguments);
    };
  }

  if (fsMod.link) {
    var _link = fsMod.link;
    fsMod.link = function (existingPath, newPath, cb) {
      S.state._currentCmdPreview = 'fs.link("' + existingPath + '", "' + newPath + '")';
      if (shouldBlockWrite(newPath)) {
        S.state._currentCmdPreview = null;
        if (typeof cb === "function") {
          cb(throwReadOnly(newPath));
          return;
        }
        throw throwReadOnly(newPath);
      }
      S.state._currentCmdPreview = null;
      return _link.apply(this, arguments);
    };
  }

  // ── NEW: chmod ──

  if (fsMod.chmodSync) {
    var _chmodSync = fsMod.chmodSync;
    fsMod.chmodSync = function (p) {
      S.state._currentCmdPreview = 'fs.chmodSync("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _chmodSync.apply(this, arguments);
    };
  }

  if (fsMod.chmod) {
    var _chmod = fsMod.chmod;
    fsMod.chmod = function (p, mode, cb) {
      S.state._currentCmdPreview = 'fs.chmod("' + p + '")';
      if (shouldBlockWrite(p)) {
        S.state._currentCmdPreview = null;
        if (typeof cb === "function") {
          cb(throwReadOnly(p));
          return;
        }
        throw throwReadOnly(p);
      }
      S.state._currentCmdPreview = null;
      return _chmod.apply(this, arguments);
    };
  }

  // ── NEW: cp (recursive copy, Node 16.7+) ──

  if (fsMod.cpSync) {
    var _cpSync = fsMod.cpSync;
    fsMod.cpSync = function (src, dest) {
      S.state._currentCmdPreview = 'fs.cpSync("' + src + '", "' + dest + '")';
      if (shouldBlockWrite(dest)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(dest);
      }
      S.state._currentCmdPreview = null;
      return _cpSync.apply(this, arguments);
    };
  }

  if (fsMod.cp) {
    var _cp = fsMod.cp;
    fsMod.cp = function (src, dest, optsOrCb, cb) {
      S.state._currentCmdPreview = 'fs.cp("' + src + '", "' + dest + '")';
      if (shouldBlockWrite(dest)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(optsOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadOnly(dest));
          return;
        }
        throw throwReadOnly(dest);
      }
      S.state._currentCmdPreview = null;
      return _cp.apply(this, arguments);
    };
  }

  // ── open / createWriteStream ──

  var _openSync = fsMod.openSync;
  fsMod.openSync = function (file, flags) {
    var f = String(flags || "r");
    S.state._currentCmdPreview = 'fs.openSync("' + file + '", "' + f + '")';
    if (f === "r" || f === "rs" || f === "sr") {
      if (shouldBlockRead(file)) {
        S.state._currentCmdPreview = null;
        throw throwReadBlocked(file);
      }
    } else {
      if (shouldBlockWrite(file)) {
        S.state._currentCmdPreview = null;
        throw throwReadOnly(file);
      }
    }
    S.state._currentCmdPreview = null;
    return _openSync.apply(this, arguments);
  };

  var _open = fsMod.open;
  fsMod.open = function (file, flags, modeOrCb, cb) {
    var f = String(flags || "r");
    S.state._currentCmdPreview = 'fs.open("' + file + '", "' + f + '")';
    if (f === "r" || f === "rs" || f === "sr") {
      if (shouldBlockRead(file)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(modeOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadBlocked(file));
          return;
        }
        throw throwReadBlocked(file);
      }
    } else {
      if (shouldBlockWrite(file)) {
        S.state._currentCmdPreview = null;
        var callback = getCb2(modeOrCb, cb);
        if (typeof callback === "function") {
          callback(throwReadOnly(file));
          return;
        }
        throw throwReadOnly(file);
      }
    }
    S.state._currentCmdPreview = null;
    return _open.apply(this, arguments);
  };

  var _createWriteStream = fsMod.createWriteStream;
  fsMod.createWriteStream = function (file) {
    S.state._currentCmdPreview = 'fs.createWriteStream("' + file + '")';
    if (shouldBlockWrite(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadOnly(file);
    }
    S.state._currentCmdPreview = null;
    return _createWriteStream.apply(this, arguments);
  };

  // ── Read operations ───────────────────────────────────────────────────

  var _readFileSync = fsMod.readFileSync;
  fsMod.readFileSync = function (file) {
    S.state._currentCmdPreview = 'fs.readFileSync("' + file + '")';
    if (shouldBlockRead(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadBlocked(file);
    }
    S.state._currentCmdPreview = null;
    return _readFileSync.apply(this, arguments);
  };

  var _readFile = fsMod.readFile;
  fsMod.readFile = function (file, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.readFile("' + file + '")';
    if (shouldBlockRead(file)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadBlocked(file));
        return;
      }
      throw throwReadBlocked(file);
    }
    S.state._currentCmdPreview = null;
    return _readFile.apply(this, arguments);
  };

  var _readdirSync = fsMod.readdirSync;
  fsMod.readdirSync = function (dir) {
    S.state._currentCmdPreview = 'fs.readdirSync("' + dir + '")';
    if (shouldBlockRead(dir)) {
      S.state._currentCmdPreview = null;
      throw throwReadBlocked(dir);
    }
    S.state._currentCmdPreview = null;
    return _readdirSync.apply(this, arguments);
  };

  var _readdir = fsMod.readdir;
  fsMod.readdir = function (dir, optsOrCb, cb) {
    S.state._currentCmdPreview = 'fs.readdir("' + dir + '")';
    if (shouldBlockRead(dir)) {
      S.state._currentCmdPreview = null;
      var callback = getCb2(optsOrCb, cb);
      if (typeof callback === "function") {
        callback(throwReadBlocked(dir));
        return;
      }
      throw throwReadBlocked(dir);
    }
    S.state._currentCmdPreview = null;
    return _readdir.apply(this, arguments);
  };

  var _createReadStream = fsMod.createReadStream;
  fsMod.createReadStream = function (file) {
    S.state._currentCmdPreview = 'fs.createReadStream("' + file + '")';
    if (shouldBlockRead(file)) {
      S.state._currentCmdPreview = null;
      throw throwReadBlocked(file);
    }
    S.state._currentCmdPreview = null;
    return _createReadStream.apply(this, arguments);
  };

  // NOTE: stat, lstat, access are intentionally NOT hooked.
  // These are metadata-probing operations (file existence, size, permissions)
  // called constantly by Node.js internals (module resolution, chokidar file
  // watcher, hasBin PATH search, source-map-support, etc.). Hooking them
  // causes cascading permission dialogs for gateway infrastructure operations.
  // AppContainer ACL handles actual access control at the OS level.

  // ── fs/promises hooks ─────────────────────────────────────────────────

  var fsPromises = fsMod.promises;
  if (fsPromises) {
    var _pWriteFile = fsPromises.writeFile;
    fsPromises.writeFile = function (file) {
      S.state._currentCmdPreview = 'fs.promises.writeFile("' + file + '")';
      if (shouldBlockWrite(file)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(file));
      }
      S.state._currentCmdPreview = null;
      return _pWriteFile.apply(this, arguments);
    };

    var _pAppendFile = fsPromises.appendFile;
    fsPromises.appendFile = function (file) {
      S.state._currentCmdPreview = 'fs.promises.appendFile("' + file + '")';
      if (shouldBlockWrite(file)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(file));
      }
      S.state._currentCmdPreview = null;
      return _pAppendFile.apply(this, arguments);
    };

    var _pCopyFile = fsPromises.copyFile;
    fsPromises.copyFile = function (src, dest) {
      S.state._currentCmdPreview = 'fs.promises.copyFile("' + src + '", "' + dest + '")';
      if (shouldBlockWrite(dest)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(dest));
      }
      S.state._currentCmdPreview = null;
      return _pCopyFile.apply(this, arguments);
    };

    var _pRename = fsPromises.rename;
    fsPromises.rename = function (oldPath, newPath) {
      S.state._currentCmdPreview = 'fs.promises.rename("' + oldPath + '", "' + newPath + '")';
      if (shouldBlockWrite(oldPath) || shouldBlockWrite(newPath)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(oldPath));
      }
      S.state._currentCmdPreview = null;
      return _pRename.apply(this, arguments);
    };

    var _pUnlink = fsPromises.unlink;
    fsPromises.unlink = function (file) {
      S.state._currentCmdPreview = 'fs.promises.unlink("' + file + '")';
      if (shouldBlockWrite(file)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(file));
      }
      S.state._currentCmdPreview = null;
      return _pUnlink.apply(this, arguments);
    };

    var _pMkdir = fsPromises.mkdir;
    fsPromises.mkdir = function (dir) {
      S.state._currentCmdPreview = 'fs.promises.mkdir("' + dir + '")';
      if (shouldBlockWrite(dir)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(dir));
      }
      S.state._currentCmdPreview = null;
      return _pMkdir.apply(this, arguments);
    };

    var _pRmdir = fsPromises.rmdir;
    fsPromises.rmdir = function (dir) {
      S.state._currentCmdPreview = 'fs.promises.rmdir("' + dir + '")';
      if (shouldBlockWrite(dir)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadOnly(dir));
      }
      S.state._currentCmdPreview = null;
      return _pRmdir.apply(this, arguments);
    };

    if (fsPromises.rm) {
      var _pRm = fsPromises.rm;
      fsPromises.rm = function (p) {
        S.state._currentCmdPreview = 'fs.promises.rm("' + p + '")';
        if (shouldBlockWrite(p)) {
          S.state._currentCmdPreview = null;
          return Promise.reject(throwReadOnly(p));
        }
        S.state._currentCmdPreview = null;
        return _pRm.apply(this, arguments);
      };
    }

    var _pOpen = fsPromises.open;
    fsPromises.open = function (file, flags) {
      var f = String(flags || "r");
      S.state._currentCmdPreview = 'fs.promises.open("' + file + '", "' + f + '")';
      if (f === "r" || f === "rs" || f === "sr") {
        if (shouldBlockRead(file)) {
          S.state._currentCmdPreview = null;
          return Promise.reject(throwReadBlocked(file));
        }
      } else {
        if (shouldBlockWrite(file)) {
          S.state._currentCmdPreview = null;
          return Promise.reject(throwReadOnly(file));
        }
      }
      S.state._currentCmdPreview = null;
      return _pOpen.apply(this, arguments);
    };

    var _pReadFile = fsPromises.readFile;
    fsPromises.readFile = function (file) {
      S.state._currentCmdPreview = 'fs.promises.readFile("' + file + '")';
      if (shouldBlockRead(file)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadBlocked(file));
      }
      S.state._currentCmdPreview = null;
      return _pReadFile.apply(this, arguments);
    };

    var _pReaddir = fsPromises.readdir;
    fsPromises.readdir = function (dir) {
      S.state._currentCmdPreview = 'fs.promises.readdir("' + dir + '")';
      if (shouldBlockRead(dir)) {
        S.state._currentCmdPreview = null;
        return Promise.reject(throwReadBlocked(dir));
      }
      S.state._currentCmdPreview = null;
      return _pReaddir.apply(this, arguments);
    };

    // ── NEW promise hooks ──

    if (fsPromises.truncate) {
      var _pTruncate = fsPromises.truncate;
      fsPromises.truncate = function (p) {
        if (shouldBlockWrite(p)) return Promise.reject(throwReadOnly(p));
        return _pTruncate.apply(this, arguments);
      };
    }

    if (fsPromises.symlink) {
      var _pSymlink = fsPromises.symlink;
      fsPromises.symlink = function (target, p) {
        if (shouldBlockWrite(p)) return Promise.reject(throwReadOnly(p));
        return _pSymlink.apply(this, arguments);
      };
    }

    if (fsPromises.link) {
      var _pLink = fsPromises.link;
      fsPromises.link = function (existingPath, newPath) {
        if (shouldBlockWrite(newPath)) return Promise.reject(throwReadOnly(newPath));
        return _pLink.apply(this, arguments);
      };
    }

    if (fsPromises.chmod) {
      var _pChmod = fsPromises.chmod;
      fsPromises.chmod = function (p) {
        if (shouldBlockWrite(p)) return Promise.reject(throwReadOnly(p));
        return _pChmod.apply(this, arguments);
      };
    }

    if (fsPromises.cp) {
      var _pCp = fsPromises.cp;
      fsPromises.cp = function (src, dest) {
        if (shouldBlockWrite(dest)) return Promise.reject(throwReadOnly(dest));
        return _pCp.apply(this, arguments);
      };
    }

    // NOTE: fsPromises.stat, lstat, access are intentionally NOT hooked.
    // See comment above for sync counterparts.
  }

  if (S.state._roDirs.length > 0) {
    process.stderr.write(
      "[sandbox-preload] RO fs enforcement for " +
        S.state._roDirs.length +
        " dir(s): " +
        S.state._roDirs.join(", ") +
        "\n",
    );
  }
}

module.exports = { install: install };
