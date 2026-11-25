import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,mkdir,symlink } from 'node:fs/promises';
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

test('project vocabulary ignores contacts, links and a nested project', async () => {
 const dir=await mkdtemp(join(tmpdir(),'lt-vocabulary-'));
 try {
  const root=join(dir,'project');await mkdir(root);await mkdir(join(root,'meetings'));await mkdir(join(root,'.hidden'));await mkdir(join(root,'nested'));
  await writeFile(join(root,'AGENTS.md'),'Сервис использует FluidAudio.');
  await writeFile(join(root,'glossary.md'),'- Ласточка — название проекта');
  await writeFile(join(root,'meetings','итоги.md'),'Проверит Иван Иванов.');
  await writeFile(join(root,'.hidden','contacts.md'),'- HiddenCorp — контакт');
  await writeFile(join(dir,'outside.md'),'- OutsideCorp — контакт');
  await symlink(join(dir,'outside.md'),join(root,'terms.md'));
  await writeFile(join(root,'contacts.md'),'- ContactCorp — контакт');
  await writeFile(join(root,'nested','glossary.md'),'- NestedCorp — термин');
  const terms=await h.projectVocabulary({root,excludedRoots:[join(root,'nested')]},{});
  assert.ok(terms.includes('Ласточка'));
  assert.ok(terms.includes('FluidAudio'));
  assert.ok(terms.includes('Иван Иванов'));
  assert.ok(!terms.some(term => /HiddenCorp|OutsideCorp|ContactCorp|NestedCorp/.test(term)));
  const path=await h.writeVocabulary({folder:root,terms},{});
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),terms);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('vocabulary ranks curated spellings and independent meeting evidence within its cap', async () => {
  const root=await mkdtemp(join(tmpdir(),'lt-ranked-vocabulary-'));
  try {
    await writeFile(join(root,'люди-и-роли.md'),'| Имя | Роль |\n| **Никита** | инженер |');
    await writeFile(join(root,'architecture.md'),'Хостинг на Selectel. Пример XТест.\n```sh\nВыполнить SecretRunner\n```');
    await writeFile(join(root,'2026-01-08_ИТОГИ.md'),'Переносим в Selectel. Работает Надежда.');
    for (const name of ['jan','feb']) {
      await mkdir(join(root,name));
      await writeFile(join(root,name,'transcript.txt'),'Speaker 2 [01:20]: Проверили Ластомель и уехали.');
    }
    await writeFile(join(root,'jan','transcript-raw.txt'),'Speaker 0 [01:20]: Вижу Хвосток.');
    await writeFile(join(root,'jan','transcript-v2.txt'),'Speaker 0 [01:20]: Вижу Хвосток.');
    const sparse=await h.projectVocabulary({root},{});
    for (const term of ['Никита','Никитой','Никиты','Selectel','Надежда','Ластомель']) assert.ok(sparse.includes(term),term);
    for (const term of ['Имя','Speaker','Роль','Хвосток','XТест','SecretRunner']) assert.ok(!sparse.includes(term),term);

    await writeFile(join(root,'extra.md'),Array.from({length:90},(_,i)=>'Подключили ExtraName'+i+'.').join('\n'));
    const capped=await h.projectVocabulary({root},{});
    assert.equal(capped.length,64);
    assert.ok(capped.includes('Никитой'));
    assert.ok(capped.includes('Selectel'));
    assert.equal(new Set(capped.map(term=>term.toLowerCase())).size,64);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('named rendering changes only the speaker prefix and never overwrites the source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lt-named-'));
 try {
  const source=join(dir,'transcript.txt');
  const filename='voice-labels-a5.txt';
  const original='Speaker 0 [00:01]: Привет Speaker 1 [00:02].\nГоворящий неясен [00:02]: Да.\nSpeaker 1 [00:03]: Пока.';
  await writeFile(source,original);
  const spec={source,filename,labels:[{speaker:0,name:'Тестовый Голос'}]};
  const output=await h.voiceRender(spec,{});
  assert.equal(await readFile(output,'utf8'),original.replace('Speaker 0','Тестовый Голос'));
  assert.equal(await readFile(source,'utf8'),original);
  await assert.rejects(h.voiceRender(spec,{}),/EEXIST/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
