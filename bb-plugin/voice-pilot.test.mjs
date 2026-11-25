import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import plugin from './dist/server.js';

const key = 'a7'.repeat(32);
const encoder = 'campplus:' + 'c1'.repeat(32) + ':pcm16-s16le-v1:192';
const unit = [1, ...Array(191).fill(0)];
const inputA = {jobId:'00000000-0000-4000-8000-000000000001', speaker:0};
const inputB = {jobId:'00000000-0000-4000-8000-000000000002', speaker:0};
const scopeA = {threadId:'a', projectId:'p-a'};
const scopeB = {threadId:'b', projectId:'p-b'};

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = {
    prepare: sql => sqlite.prepare(sql), exec: sql => sqlite.exec(sql),
    transaction: fn => (...args) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result=fn(...args); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const values = new Map();
  for (const [{jobId}, {projectId,threadId}] of [[inputA,scopeA],[inputB,scopeB]]) {
    values.set('job:'+jobId, {
      id:jobId, threadId, sourceProjectId:projectId, state:'completed', input:{speakers:true},
      result:{path:'/transcript-original.txt',hostId:'project-host'}, serviceHostId:'executor', workPath:'/work/'+jobId,
      runtimePath:'/runtime',python:'/venv/python',
    });
  }
  const tools = new Map();
  const forms = [];
  const routes = new Map();
  let rpc;
  const config={voicePilotProjects:'["p-a","p-b"]',voiceRegistryKey:key};
  let hostAudioCalls=0, offline=false;
  plugin({
    settings:{define:()=>({get:async()=>config, experimental_set:async value=>Object.assign(config,value)})},
    storage:{
      database:()=>db, migrate:(_db,sql)=>sql.forEach(statement=>db.exec(statement)),
      kv:{get:async id=>values.get(id),list:async(prefix='')=>[...values.keys()].filter(id=>id.startsWith(prefix))},
    },
    hosts:{experimental_client:()=>({call:async(method,args)=>{
      if(method==='voiceFeatures' && offline) throw new Error('Host is not connected');
      if(method==='voiceFeatures') return args.speaker === undefined ?
        [{speaker:0,hasSample:true}] :
        {encoder,examples:[{start:1,vector:unit},{start:7,vector:unit}]};
      if(method==='voiceRender') {
        assert.equal(args.source,'/transcript-original.txt');
        assert.deepEqual(args.labels,[{speaker:0,name:'Другой Голос'}]);
        return '/named-transcript.txt';
      }
      if(method==='voiceClip') { hostAudioCalls++; return Buffer.from('RIFF').toString('base64');}
      throw new Error(method);
    }})},
    sdk:{
      threads:{get:async({threadId})=>({environmentId:threadId})},
      environments:{get:async({environmentId})=>({projectId:'p-'+environmentId})},
    },
    rpc:{register:(_contract,handlers)=>rpc=handlers},
    agents:{registerTool:spec=>tools.set(spec.name,spec),contributeInstructions:()=>{}},
    ui:{requestInput:request=>new Promise(resolve=>forms.push({request,resolve}))},
    http:{route:(method,path,handler,options)=>routes.set(path,{method,handler,options})},
    background:{service:()=>{}},
  });
  const call = async (suffix,value,context) => {
    const tool=tools.get('local_transcribe_voice_'+suffix);
    return JSON.parse(await tool.execute(tool.parameters.parse(value),context));
  };
  const open = async (action,value,context) => {
    const result=call(action,value,context);
    const outcome=result.then(value=>({value}),error=>({error}));
    // A native form must be scheduled before handling its human answer.
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(forms.length, (await Promise.race([outcome, Promise.resolve({})])).error?.message);
    const form = forms.shift();
    return { ...form, result };
  };
  const readPreview = (url) => {
    const route=routes.get('/voice-sample');
    assert.equal(route.options.auth,'local');
    const token=new URL(url,'http://localhost').searchParams.get('review');
    return route.handler({req:{query:()=>token}});
  };
  return { call, open, readPreview, db, rpc, config, disconnect:()=>{offline=true;}, audioCalls:()=>hostAudioCalls };
}

test('manual pilot enrolls a voice, confirms first cross-project match, corrects and deletes it', async t => {
  const s=setup(t);
  assert.deepEqual((await s.call('map', {jobId:inputA.jobId}, scopeA)).confirmed,[]);
  await assert.rejects(s.call('map',{jobId:inputA.jobId},scopeB),/unavailable in this thread/);
  const form=await s.open('review',inputA,scopeA);
  assert.match(form.request.title,/Говорящий 0 — кто/);
  const url=form.request.payload.audio;
  assert.equal((await s.readPreview(url)).status,200);
  assert.equal(await (await s.readPreview(url)).text(),'RIFF');
  assert.equal(s.audioCalls(),1);
  form.resolve({outcome:'submitted',value:{name:'Тестовый Голос',saveVoice:true,consent:true,allowAcrossProjects:true}});
  assert.equal((await form.result).name,'Тестовый Голос');
  assert.equal((await s.readPreview(url)).status,404);
  assert.doesNotMatch(s.db.prepare('SELECT payload FROM voice_profiles').get().payload,/Тестовый Голос/);
  assert.equal((await s.rpc.migrationSnapshot()).settings.voiceRegistryKey,undefined);

  const [profile]=await s.call('profiles',{},scopeA);
  assert.deepEqual(await s.call('profiles',{},scopeB),[]);
  assert.deepEqual((await s.call('map',{jobId:inputB.jobId},scopeB)).confirmed,[]);
  const firstB=await s.open('review',inputB,scopeB);
  assert.equal(firstB.request.payload.choices[0].crossProject,true);
  firstB.resolve({outcome:'submitted',value:{profileId:profile.id}});
  await assert.rejects(firstB.result,/Confirm the first match/);
  assert.deepEqual(await s.call('profiles',{},scopeB),[]);

  const secondB=await s.open('review',inputB,scopeB);
  secondB.resolve({outcome:'submitted',value:{profileId:profile.id,transferConsent:true}});
  assert.equal((await secondB.result).name,'Тестовый Голос');
  assert.equal((await s.call('profiles',{},scopeB))[0].id,profile.id);

  s.disconnect();
  assert.equal((await s.call('map',{jobId:inputB.jobId},scopeB)).pendingUnavailable,true);
  const correction=await s.open('review',{...inputB,proposedName:'Другой Голос'},scopeB);
  correction.resolve({outcome:'submitted',value:{name:'Другой Голос'}});
  assert.equal((await correction.result).name,'Другой Голос');
  assert.equal((await s.call('map',{jobId:inputB.jobId},scopeB)).originalTranscript,'/transcript-original.txt');

  assert.equal((await s.call('render',{jobId:inputB.jobId},scopeB)).path,'/named-transcript.txt');

  const forget=await s.open('forget',{profileId:profile.id},scopeB);
  forget.resolve({outcome:'submitted',value:true});
  assert.equal((await forget.result).outcome,'deleted');
  assert.deepEqual((await s.call('map',{jobId:inputA.jobId},scopeA)).confirmed,[]);
  assert.equal((await s.call('map',{jobId:inputB.jobId},scopeB)).confirmed[0].name,'Другой Голос');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM voice_profiles').get().n,0);
});

test('consent, project access and no cross-project permission fail closed', async t => {
  const s=setup(t);
  await assert.rejects(s.call('profiles',{}, {threadId:'c',projectId:'p-c'}),/not enabled/);
  const noConsent=await s.open('review',inputA,scopeA);
  noConsent.resolve({outcome:'submitted',value:{name:'Участник',saveVoice:true}});
  await assert.rejects(noConsent.result,/consent/);
  assert.deepEqual(await s.call('profiles',{},scopeA),[]);

  const privateVoice=await s.open('review',inputA,scopeA);
  privateVoice.resolve({outcome:'submitted',value:{name:'Участник',saveVoice:true,consent:true}});
  await privateVoice.result;
  const foreign=await s.open('review',inputB,scopeB);
  assert.deepEqual(foreign.request.payload.choices,[]);
  assert.equal(foreign.request.payload.suggestionId,null);
  foreign.resolve({outcome:'cancelled'});
  assert.equal((await foreign.result).outcome,'skipped');
  assert.equal((await s.readPreview(foreign.request.payload.audio)).status,404);

  s.config.voiceRegistryKey='0d'.repeat(32);
  await assert.rejects(s.call('profiles',{},scopeA),/cannot be unlocked/);
});

test('a stale concurrent review cannot overwrite a newer confirmation', async t => {
  const s=setup(t);
  const first=await s.open('review',inputA,scopeA);
  const second=await s.open('review',inputA,scopeA);
  first.resolve({outcome:'submitted',value:{name:'Первый Ответ'}});
  await first.result;
  second.resolve({outcome:'submitted',value:{name:'Старый Ответ'}});
  await assert.rejects(second.result,/changed while the form was open/);
});
