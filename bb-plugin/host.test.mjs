import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import host from './dist/host.js';
const h=host.handlers;

test('same-host copy preserves bytes and refuses overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'transcribe-copy-'));
 try {
  const source=join(dir,'source'),target=join(dir,'target');await writeFile(source,'source data');
  const result=await h.localCopy({source,target},{});
  assert.equal(result.sha256,createHash('sha256').update('source data').digest('hex'));
  await assert.rejects(h.localCopy({source,target},{}));
  assert.equal(await readFile(source,'utf8'),'source data');assert.equal(await readFile(target,'utf8'),'source data');
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('host lease cannot renew after sleep or change its attempt token',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'transcribe-lease-'));const path=join(dir,'.lease.json');const token=randomUUID();
 try {
  assert.equal(await h.lease({path,token,expiresAt:Date.now()+30000,create:true},{}),true);
  assert.equal(await h.lease({path,token:randomUUID(),expiresAt:Date.now()+40000,create:false},{}),false);
  assert.equal(await h.lease({path,token,expiresAt:Date.now()+40000,create:false},{}),true);
  await writeFile(path,JSON.stringify({token,expiresAt:Date.now()-1}));
  assert.equal(await h.lease({path,token,expiresAt:Date.now()+40000,create:false},{}),false);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('a corrupted transfer is not published',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'transcribe-integrity-'));
 try {
  const target=join(dir,'result');const path=await h.begin({path:target,token:randomUUID()},{});
  await h.append({path,offset:0,data:Buffer.from('abc').toString('base64')},{});
  await assert.rejects(h.append({path,offset:0,data:'eA=='},{}),/offset mismatch/);
  await assert.rejects(h.finish({path,target,sha256:'wrong',size:3},{}),/checksum mismatch/);
  await assert.rejects(readFile(target));assert.equal(await readFile(path,'utf8'),'abc');
 } finally {await rm(dir,{recursive:true,force:true});}
});
