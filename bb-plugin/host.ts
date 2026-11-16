import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { materializeRuntime } from './runtime.js';
import { hostContract } from './contract.js';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, mkdir, stat, link, unlink, access, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
function absolute(path: string) {
  if (!isAbsolute(path)) throw new Error('An absolute path is required');
  return path;
}
async function info(path: string) {
  absolute(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: (await stat(path)).size, sha256: hash.digest('hex') };
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async runtime(_input,context) {return materializeRuntime(context.experimental_paths.dataDir);},
    async localCopy({ source, target }) {
      absolute(source); absolute(target);
      const before = await info(source);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const copied = await info(target);
      if (before.sha256 !== copied.sha256 || before.size !== copied.size) {
        await unlink(target); throw new Error('Source changed during local copy');
      }
      return { path: target, ...copied };
    },
    async lease({ path, token, expiresAt, create }) {
      absolute(path);
      if (!path.endsWith('/.lease.json')) throw new Error('Invalid lease path');
      if (expiresAt < Date.now()+1000 || expiresAt > Date.now()+300000) throw new Error('Invalid lease expiration');
      const data = JSON.stringify({ token, expiresAt });
      if (create) { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); return true; }
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.token !== token || current.expiresAt <= Date.now()) return false;
      const temporary = path + '.' + randomUUID();
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path); return true;
    },
    async probe({ repoPath, python, legacySourcePath }, context) {
      try {
        if (python === 'auto') {
          const isolated = join(legacySourcePath ?? repoPath, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
          python = await access(isolated).then(() => isolated, () => 'python3');
        }
        const { stdout } = await exec(python, [absolute(repoPath) + '/probe_service.py'], {
          cwd: repoPath, signal: context.signal, timeout: 20000, maxBuffer: 65536,
        });
        return { ...JSON.parse(stdout.trim().split('\n').at(-1)!), python };
      } catch (error) { return { ready: false, missing: [String(error)], device: null }; }
    },
    info: ({ path }) => info(path),
    async infoMaybe({ path }) {
      try { return await info(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async read({ path, offset, size }) {
      const file = await open(absolute(path), 'r');
      try {
        const buf = Buffer.alloc(size); const { bytesRead } = await file.read(buf, 0, size, offset);
        return buf.subarray(0, bytesRead).toString('base64');
      } finally { await file.close(); }
    },
    async begin({ path, token }) {
      absolute(path);
      try { await stat(path); throw new Error('Target already exists: ' + path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(path), { recursive: true });
      const partial = path + '.part-' + token;
      const file = await open(partial, 'wx', 0o600); await file.close(); return partial;
    },
    async append({ path, offset, data }) {
      if (!/\.part-[a-f0-9-]{36}$/.test(path)) throw new Error('Invalid partial file');
      const file = await open(absolute(path), 'r+');
      try {
        if ((await file.stat()).size !== offset) throw new Error('Transfer offset mismatch');
        const buf = Buffer.from(data, 'base64');
        let written = 0;
        while (written < buf.length) {
          const result = await file.write(buf, written, buf.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('Incomplete transfer write');
          written += result.bytesWritten;
        }
        return written;
      } finally { await file.close(); }
    },
    async finish({ path, target, sha256, size }) {
      if (!path.startsWith(target + '.part-')) throw new Error('Invalid partial target');
      const result = await info(path);
      if (result.sha256 !== sha256 || result.size !== size) throw new Error('Transfer checksum mismatch');
      await link(absolute(path), absolute(target)); // Atomic create-only; no overwrite.
      await unlink(path); return { path: target, ...result };
    },
    async mkdir({ path }) { await mkdir(absolute(path), { recursive: true }); return true; },
  },
});

export { materializeRuntime, verifyBundle } from "./runtime.js";
