import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './dist/server.js';

function setup(options = {}) {
  const store = new Map(); let rpc, worker;
  const launches = [], closed = [], vocabularyWrites = [], vocabularyReads = [];
  const machines = [{id:'mac-id',name:'MacBook',status:'connected'}, {id:'tru-id',name:'Tru',status:'connected'}];
  const api = {
    settings: { define: () => ({get: async () => ({workerHosts:'[]',autoSetup:true,leaseSeconds:120,projectName:'local-transcribe',neutralVocabulary:options.neutralVocabulary ?? '[]',fallback:'["self","available"]'})}) },
    storage: {kv: {get: async k => structuredClone(store.get(k)), set: async(k,v) => store.set(k,structuredClone(v)),list:async()=>[...store.keys()]}},
    sdk: {
      hosts: {list:async()=>machines},
      projects: {list:async()=>[{id:'project',name:'local-transcribe',sources:machines.map(m=>({hostId:m.id,path:'/repo'}))},...(options.projects ?? [])]},
      threads: {get:async({threadId})=>({environmentId:threadId})},
      environments:{
        get:async({environmentId})=>options.environments?.[environmentId] ?? {hostId:'tru-id',path:'/src',projectId:'project'},
        list:async({hostId})=>Object.values(options.environments ?? {}).filter(environment=>environment.hostId===hostId),
      },
      terminals: {
        create:async args => {launches.push(args);return {id:args.id,status:'running'};},
        get:async()=> {
          if(options.disconnected && (!options.onlyFirstDisconnected || launches.length===1)) throw new Error('disconnected');
          return {status:'exited',exitCode:options.failPrimary && launches.length===1 ? 1 : 0};
        },
        output:async()=>({exitCode:1,chunks:[]}),
        close:async args=>closed.push(args),
      },
    },
    hosts:{experimental_client:()=>({call:async(method,args,{hostId})=> {
      if(method==='runtime')return {runtimePath:'/repo',workRoot:'/repo/work',runtimeVersion:'0.2.0',runtimeSha256:'hash',requirementsHash:'deps',managedPython:options.environmentPending?null:'python3',needsSetup:!!options.environmentPending};
      if(method==='projectVocabulary') {
        vocabularyReads.push({hostId,...args});
        return options.projectTerms?.[args.root] ?? ['Иван Иванов'];
      }
      if(method==='writeVocabulary') {
        vocabularyWrites.push({hostId,...args});
        return args.folder+'/vocabulary.json';
      }
      if(method==='lease')return true;
      if(method==='localCopy'){if(options.existing)throw new Error('Target already exists');return {path:args.target,size:3,sha256:'digest'};}
      if(method==='probe') return {contextVocabulary:!!options.contextVocabulary,ready:hostId==='mac-id'||!!options.truReady,device:hostId==='mac-id'?'mps':'cpu',platform:hostId==='mac-id'?'Darwin':'Linux',missing:hostId==='mac-id'||options.truReady?[]:['model missing']};
      if(method==='infoMaybe')return null;
      if(method==='info')return {size:3,sha256:'digest'};
      if(method==='begin') {if(options.failDeliveryOnce && args.path==='/out.txt' && !options.deliveryFailed){options.deliveryFailed=true;throw new Error('Timed out waiting for command result');}if(options.existing)throw new Error('Target already exists');return args.path+'.part-'+args.token;}
      if(method==='read')return Buffer.from('abc').toString('base64');
      if(method==='append')return 3;
      if(method==='finish')return {path:args.target,size:3,sha256:'digest'};
      throw new Error(method);
    }})},
    rpc:{register:(_contract,handlers)=>rpc=handlers},
    http:{route:()=>{}},
    agents:{registerTool:()=>{},contributeInstructions:()=>{}},
    background:{service:(name,handler)=>{if(name==='transcription-jobs')worker=handler;}},log:{error:error=>{throw new Error(error)},warn:()=>{}},
  };
  plugin(api);
  return {rpc,launches,closed,store,worker,vocabularyWrites,vocabularyReads};
}
async function until(check, limit=10000) {
  const end = Date.now()+limit;
  while(Date.now()<end) {if(await check())return;await new Promise(r=>setTimeout(r,20));}
  throw new Error('Timed out waiting for job state');
}
const input = {inputPath:'/input.wav',outputPath:'/out.txt',threadId:'caller'};

test('self resolves to the invoking thread host and default fallback is explicit', async()=>{
  const s=setup();const result=await s.rpc.submit(input);
  const job=await s.rpc.status({jobId:result.jobId});
  assert.equal(job.selfHostId,'tru-id');assert.equal(job.input.inputHostId,'tru-id');
  assert.equal(job.input.outputHostId,'tru-id');assert.deepEqual(result.fallback,['self','available']);
});
test('outside a thread explicit source and destination are required',async()=>{
  const s=setup();await assert.rejects(s.rpc.submit({inputPath:'/in',outputPath:'/out'}),/required outside a thread/);
});
test('unready primary falls through only to the supplied fallback and returns the result',async()=>{
  const s=setup();const ctrl=new AbortController();
  const r=await s.rpc.submit({...input,service:'tru-id',fallback:['mac']});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');
    const j=await s.rpc.status({jobId:r.jobId});
    assert.equal(j.serviceHostId,'mac-id');assert.equal(j.attempts[0].hostId,'tru-id');
    assert.equal(s.launches.length,1);assert.equal(j.result.hostId,'tru-id');
    assert.match(j.terminalId,/^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
  } finally {ctrl.abort();await running;}
});
test('disconnected running terminal never launches fallback or duplicate; cancellation stops it',async()=>{
  const s=setup({disconnected:true,truReady:true});const ctrl=new AbortController();
  const r=await s.rpc.submit({...input,service:'mac',fallback:['self']});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(async()=>!!(await s.rpc.status({jobId:r.jobId})).connectionError);
    assert.equal(s.launches.length,1);
    const cancelled=await s.rpc.cancel({jobId:r.jobId});assert.equal(cancelled.state,'cancelled');
    assert.equal(s.closed.length,1);assert.equal((await s.rpc.status({jobId:r.jobId})).state,'cancelled');
  } finally {ctrl.abort();await running;}
});
test('confirmed process failure switches to a ready caller service',async()=>{
  const s=setup({failPrimary:true,truReady:true});const ctrl=new AbortController();
  const r=await s.rpc.submit({...input,service:'mac',fallback:['self']});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');
    assert.equal(s.launches.length,2);assert.equal((await s.rpc.status({jobId:r.jobId})).serviceHostId,'tru-id');
  } finally {ctrl.abort();await running;}
});
test('existing destination is rejected and is never overwritten',async()=>{
  const s=setup({existing:true});await assert.rejects(s.rpc.copy({sourceHostId:'mac-id',sourcePath:'/in',targetHostId:'tru-id',targetPath:'/out'}),/already exists/);
});

test('a running job keeps its place before a newly queued job',async()=>{
  const s=setup({disconnected:true,truReady:true});const ctrl=new AbortController();
  const first=await s.rpc.submit({...input,service:'mac',fallback:['self']});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(()=>s.launches.length===1);
    const second=await s.rpc.submit({...input,outputPath:'/other.txt',service:'mac',fallback:['self']});
    await until(async()=>!!(await s.rpc.status({jobId:first.jobId})).connectionError);
    assert.equal((await s.rpc.status({jobId:second.jobId})).state,'queued');
    assert.equal(s.launches.length,1);
    await s.rpc.cancel({jobId:first.jobId});await s.rpc.cancel({jobId:second.jobId});
  } finally {ctrl.abort();await running;}
});

test('requested outputs are delivered separately and reported with checksums',async()=>{
  const s=setup();const ctrl=new AbortController();
  const r=await s.rpc.submit({...input,outputs:{segments:'/segments.json',audio:'/audio.m4a',source:'/source.webm'}});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');
    const job=await s.rpc.status({jobId:r.jobId});
    assert.deepEqual(Object.keys(job.result.artifacts).sort(),['audio','segments','source','transcript']);
    assert.ok(s.launches[0].start.argv.includes('--audio'));assert.ok(s.launches[0].start.argv.includes('--segments'));
    assert.equal(job.result.artifacts.source.path,'/source.webm');
  } finally {ctrl.abort();await running;}
});
test('conflicting artifact paths are rejected before recognition',async()=>{
  const s=setup();await assert.rejects(s.rpc.submit({...input,outputs:{audio:'/out.txt'}}),/must be different/);
  assert.equal(s.launches.length,0);
});

test('an expired executor lease fences a disconnected attempt and selects the next service',async()=>{
  const options={disconnected:true,truReady:true,onlyFirstDisconnected:true};
  const s=setup(options);const ctrl=new AbortController();
  const r=await s.rpc.submit({...input,service:'mac',fallback:['self']});
  const running=s.worker.start(ctrl.signal);
  try {
    await until(()=>s.launches.length===1);
    const key='job:'+r.jobId;const stored=s.store.get(key);
    stored.leaseExpiresAt=Date.now()-11000;s.store.set(key,stored);
    await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');
    const job=await s.rpc.status({jobId:r.jobId});
    assert.equal(s.launches.length,2);assert.equal(job.serviceHostId,'tru-id');
    assert.match(job.attempts[0].error,/lease expired/);assert.equal(s.closed.length,1);
    assert.notEqual(job.terminalId,job.attempts[0].terminalId);
  } finally {ctrl.abort();await running;}
});

test('temporary delivery failure resumes existing artifacts without running recognition again',async()=>{
  const s=setup({failDeliveryOnce:true});const ctrl=new AbortController();
  const r=await s.rpc.submit(input);const running=s.worker.start(ctrl.signal);
  try {
    await until(async()=>!!(await s.rpc.status({jobId:r.jobId})).deliveryRetryAt);
    const key='job:'+r.jobId;const current=s.store.get(key);current.deliveryRetryAt=Date.now()-1;s.store.set(key,current);
    await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');
    assert.equal(s.launches.length,1);assert.equal((await s.rpc.status({jobId:r.jobId})).result.path,'/out.txt');
  } finally {ctrl.abort();await running;}
});

test('new jobs wait for a matching managed environment instead of using a legacy Python',async()=>{
 const options={environmentPending:true,truReady:true};const s=setup(options);const ctrl=new AbortController();
 const r=await s.rpc.submit(input);const running=s.worker.start(ctrl.signal);
 try {
  await until(async()=>!!(await s.rpc.status({jobId:r.jobId})).waitingForWorker);
  let job=await s.rpc.status({jobId:r.jobId});assert.equal(job.state,'queued');assert.equal(s.launches.length,0);
  assert.deepEqual(job.attempts,[]);
  options.environmentPending=false;const key='job:'+r.jobId;job=s.store.get(key);job.workerRetryAt=Date.now()-1;s.store.set(key,job);
  await until(async()=>(await s.rpc.status({jobId:r.jobId})).state==='completed');assert.equal(s.launches.length,1);
 } finally {ctrl.abort();await running;}
});

test('submit tells the caller to end its turn; status remains available on demand',async()=>{
 const s=setup();const result=await s.rpc.submit(input);assert.equal(result.wait.mode,'notification');
 assert.equal(result.wait.threadId,'caller');const job=await s.rpc.status({jobId:result.jobId});
 assert.equal(job.notifyOnFinish,true);assert.equal(job.state,'queued');
 const manual=await s.rpc.submit({...input,notify:false});assert.equal(manual.wait.mode,'manual');
 assert.equal((await s.rpc.status({jobId:manual.jobId})).notifyOnFinish,false);
});

test('GigaAM with contextual decoding receives terms from the requesting project', async () => {
  const s=setup({contextVocabulary:true});
  const ctrl=new AbortController();
  const result=await s.rpc.submit(input);
  const running=s.worker.start(ctrl.signal);
  try {
    await until(()=>s.launches.length===1);
    const [write]=s.vocabularyWrites;
    assert.equal(write.hostId,'mac-id');
    assert.deepEqual(write.terms,['local-transcribe','Иван Иванов']);
    const argv=s.launches[0].start.argv;
    assert.equal(argv[argv.indexOf('--vocabulary-file')+1],write.folder+'/vocabulary.json');
    assert.doesNotMatch(JSON.stringify(await s.rpc.status({jobId:result.jobId})),/Иван Иванов/);
  } finally {ctrl.abort();await running;}
});

test('project vocabulary is isolated across jobs and omitted when the project is unknown', async () => {
  const s=setup({
    contextVocabulary:true,
    neutralVocabulary:'["Общий бренд"]',
    projects:[
      {id:'a',name:'Проект Север',sources:[{hostId:'tru-id',path:'/projects/a'}]},
      {id:'b',name:'Проект Юг',sources:[{hostId:'tru-id',path:'/projects/b'}]},
    ],
    environments:{
      a:{hostId:'tru-id',path:'/projects/a',projectId:'a'},
      b:{hostId:'tru-id',path:'/projects/b',projectId:'b'},
      unknown:{hostId:'tru-id',path:'/projects/unknown',projectId:'unknown'},
      worktreeA:{hostId:'tru-id',path:'/worktrees/a-branch',projectId:'a'},
    },
    projectTerms:{'/projects/a':['Северный Маяк'],'/projects/b':['Южный Порт']},
  });
  const cases=[
    ['a','/projects/a/recording.wav',['Общий бренд','Проект Север','Северный Маяк']],
    ['b','/projects/b/recording.wav',['Общий бренд','Проект Юг','Южный Порт']],
    ['b','/projects/a/recording.wav',['Общий бренд']],
    ['b','/worktrees/a-branch/recording.wav',['Общий бренд']],
    ['unknown','/projects/unknown/recording.wav',['Общий бренд']],
  ];
  for (const [index,[threadId,inputPath]] of cases.entries()) {
    await s.rpc.submit({...input,threadId,inputPath,outputPath:'/out-'+index+'.txt',notify:false});
  }
  const ctrl=new AbortController();
  const running=s.worker.start(ctrl.signal);
  try {
    await until(()=>s.launches.length===cases.length,16000);
    assert.deepEqual(s.vocabularyWrites.map(write=>write.terms),cases.map(([, ,expected])=>expected));
    assert.deepEqual(s.vocabularyReads.map(read=>read.root),['/projects/a','/projects/b']);
  } finally {ctrl.abort();await running;}
});
