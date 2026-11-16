import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { materializeRuntime,verifyBundle } from './dist/host.js';
function bundle(version,code) {
 const files={'probe_service.py':Buffer.from(code).toString('base64'),'scripts/setup_worker.py':Buffer.from('# setup').toString('base64')};
 return {version,files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),requirementsHash:'a'.repeat(64)};
}
test('new worker release is side-by-side and does not replace running code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-release-'));
 try {
  const first=await materializeRuntime(root,bundle('0.2.0','old'));
  const next=await materializeRuntime(root,bundle('0.2.1','new'));
  assert.notEqual(first.runtimePath,next.runtimePath);
  assert.equal(await readFile(join(first.runtimePath,'probe_service.py'),'utf8'),'old');
  assert.equal(await readFile(join(next.runtimePath,'probe_service.py'),'utf8'),'new');
  assert.equal(first.environmentPath,next.environmentPath,'unchanged dependencies must reuse environment');
  assert.equal(first.workRoot,next.workRoot,'results must survive release replacement');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('runtime payload rejects tampering and escaping file names',()=>{
 const payload=bundle('0.2.0','old');payload.files['probe_service.py']='dGFtcGVyZWQ=';
 assert.throws(()=>verifyBundle(payload),/checksum/);
 const escaped=bundle('0.2.0','old');escaped.files['../escape']='eA==';assert.throws(()=>verifyBundle(escaped),/path/);
});

test('published payload materializes its real Python and Unicode helper resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-real-payload-'));
 try {
  const value=await materializeRuntime(root);
  assert.ok((await readFile(join(value.runtimePath,'run_service.py'),'utf8')).includes('Signal processing worker'));
  assert.ok((await readFile(join(value.runtimePath,'templates/итоги.css'),'utf8')).length>100);
  assert.ok((await readFile(join(value.runtimePath,'skills/video-downloader/scripts/download_video.py'),'utf8')).includes('yt_dlp'));
 } finally {await rm(root,{recursive:true,force:true});}
});
