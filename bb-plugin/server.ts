import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hostContract, rpcContract, submitSchema } from './contract.js';
import { candidates } from './policy.js';

export default function plugin(bb) {
  const settings = bb.settings.define({
    leaseSeconds: { type: 'number', label: 'Executor lease timeout (seconds)', default: 120, experimental_schema: z.number().int().min(30).max(240) },
    workerHosts: { type: 'string', label: 'Registered worker machine IDs (JSON array)', default: '[]' },
    autoSetup: { type: 'boolean', label: 'Prepare managed worker environments after updates', default: true },
    projectName: { type: 'string', label: 'Service project name', default: 'local-transcribe' },
    fallback: { type: 'string', label: 'Default fallback services (JSON array; self means caller)', default: '["self","available"]' },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  let migrationPaused=false;
  const save = async (job) => {
    const previous = await kv.get('job:' + job.id);
    if (previous?.state === 'cancelled' && job.state !== 'cancelled') return;
    await kv.set('job:' + job.id, { ...job, updatedAt: Date.now() });
  };
  async function services() {
    const config = await settings.get();
    const [machines, projects] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.projects.list()]);
    const registered = z.array(z.string()).parse(JSON.parse(config.workerHosts));
    const project = projects.find(p => p.name === config.projectName);
    const keys = await kv.list('job:');
    const jobs = await Promise.all(keys.map(k => kv.get(k)));
    return await Promise.all(machines.map(async machine => {
      const source = project?.sources?.find(s => s.hostId === machine.id);
      const base = { hostId: machine.id, name: machine.name, connected: machine.status === 'connected',
        repoPath: source?.path ?? null, ready: false, device: null,
        busy: jobs.some(j => j?.serviceHostId === machine.id && ['preparing','running','returning'].includes(j.state)) };
      if (!source && !registered.includes(machine.id)) return { ...base, missing: ['Worker is not registered; add it to workerHosts or the project sources'] };
      if (!base.connected) return { ...base, missing: ['Machine is disconnected'] };
      try {
        const runtime = await host.call('runtime', {}, { hostId: machine.id });
        const probe = await host.call('probe', { repoPath: runtime.runtimePath, python: runtime.managedPython ?? 'auto', ...(source ? {legacySourcePath:source.path} : {}) }, { hostId: machine.id });
        const setup = await kv.get('setup:'+machine.id+':'+runtime.requirementsHash);
        return { ...base, ...runtime, ...probe, sourcePath:source?.path ?? null, repoPath:runtime.runtimePath,
          ready:!!runtime.managedPython && probe.ready,
          missing:runtime.managedPython?probe.missing:[...(probe.missing ?? []),'Preparing the matching managed Python environment'],
          setupTerminalId:setup?.terminalId ?? null,environmentManaged:!!runtime.managedPython,setupStatus:runtime.managedPython?'ready':(setup?.status ?? 'pending') };
      } catch (error) { return { ...base, missing: [String(error)] }; }
    }));
  }
  async function copy(input) {
    const { sourceHostId, sourcePath, targetHostId, targetPath } = input;
    if (input.allowExistingMatch) {
      const current = await host.call('infoMaybe', { path: targetPath }, { hostId: targetHostId });
      if (current) {
        const source = await host.call('info', { path: sourcePath }, { hostId: sourceHostId });
        if (current.size === source.size && current.sha256 === source.sha256) return { path: targetPath, ...current };
        throw new Error('Target already exists with different content: ' + targetPath);
      }
    }
    if (sourceHostId === targetHostId && sourcePath !== targetPath)
      return host.call('localCopy', { source: sourcePath, target: targetPath }, { hostId: sourceHostId });
    const info = await host.call('info', { path: sourcePath }, { hostId: sourceHostId });
    if (sourceHostId === targetHostId && sourcePath === targetPath) return { path: targetPath, ...info };
    const partial = await host.call('begin', { path: targetPath, token: randomUUID() }, { hostId: targetHostId });
    for (let offset = 0; offset < info.size;) {
      const data = await host.call('read', { path: sourcePath, offset, size: Math.min(1048576, info.size-offset) }, { hostId: sourceHostId });
      const expected = Buffer.from(data, 'base64').length;
      if (!expected) throw new Error('Source truncated during transfer');
      const written = await host.call('append', { path: partial, offset, data }, { hostId: targetHostId });
      if (written !== expected) throw new Error('Incomplete transfer write');
      offset += written;
    }
    return await host.call('finish', { path: partial, target: targetPath, ...info }, { hostId: targetHostId });
  }
  async function submit(raw, context = {}) {
    if(migrationPaused)throw new Error('Plugin migration in progress; retry after the update');
    const input = submitSchema.parse(raw);
    const threadId = context.threadId ?? input.threadId;
    let selfHostId = null;
    if (threadId) {
      const detail = await bb.sdk.threads.get({ threadId });
      const envId = detail.environmentId ?? detail.thread?.environmentId;
      if (envId) selfHostId = (await bb.sdk.environments.get({ environmentId: envId })).hostId;
    }
    const config = await settings.get();
    const fallback = input.fallback ?? z.array(z.string()).max(8).parse(JSON.parse(config.fallback));
    const inputHostId = input.inputHostId ?? selfHostId;
    const outputHostId = input.outputHostId ?? selfHostId;
    if (!inputHostId || !outputHostId) throw new Error('inputHostId and outputHostId are required outside a thread');
    const targets = [input.outputPath, ...Object.values(input.outputs ?? {})];
    if (new Set(targets).size !== targets.length) throw new Error('Output artifact paths must be different');
    if (input.outputs?.samples && !input.speakers) throw new Error('Speaker samples require speakers=true');
    if (input.speakerCount && !input.speakers) throw new Error('speakerCount requires speakers=true');
    if (input.speakers && input.engine === 'whisper') throw new Error('Whisper endpoint does not provide speaker labels; set speakers=false explicitly');
    const job = { id: randomUUID(), state: 'queued', createdAt: Date.now(), attempts: [],
      input: { ...input, inputHostId, outputHostId, fallback }, selfHostId, threadId: threadId ?? null };
    if(migrationPaused)throw new Error('Plugin migration in progress; retry after update');
    await save(job);
    return { jobId: job.id, state: job.state, primary: input.service, fallback };
  }
  async function status({ jobId }) {
    const job = await kv.get('job:' + jobId);
    if (!job) throw new Error('Unknown transcription job');
    return job;
  }
  async function failAttempt(job, error) {
    job.attempts.push({ hostId: job.serviceHostId ?? null, terminalId: job.terminalId ?? null, workPath: job.workPath ?? null, error: String(error), at: Date.now() });
    delete job.leaseToken; delete job.leaseExpiresAt; delete job.lastHeartbeatAt; delete job.leasePath;
    job.state = 'queued'; job.terminalId = null; job.serviceHostId = null;
    await save(job);
  }
  async function prepare(job) {
    const list = await services();
    const ordered = candidates(list, job.input.service, job.input.fallback, job.selfHostId);
    const tried = new Set(job.attempts.map(a => a.hostId));
    let service;let pendingWorker=false;
    for (const id of ordered) {
      if (tried.has(id)) continue;
      const found = list.find(s => s.hostId === id);
      if (found?.ready) { service = found; break; }
      if(found?.needsSetup && found.connected && !['failed','unknown'].includes(found.setupStatus)){pendingWorker=true;continue;}
      job.attempts.push({ hostId: id, error: (found?.missing ?? ['Unknown service']).join('; '), at: Date.now() });
    }
    if (!service && pendingWorker) {
      job.workerRetryAt=Date.now()+5000;job.waitingForWorker=true;await save(job);return;
    }
    if (!service) {
      job.state = 'failed'; job.error = 'No ready service in the requested primary/fallback policy';
      await save(job); return;
    }
    delete job.workerRetryAt;delete job.waitingForWorker;
    job.state = 'preparing'; job.serviceHostId = service.hostId;
    job.workPath = (service.workRoot ?? service.repoPath + '/work') + '/' + job.id + '/' + job.attempts.length;
    job.runtimeVersion = service.runtimeVersion ?? 'legacy'; job.runtimePath = service.repoPath; job.runtimeSha256 = service.runtimeSha256 ?? null; job.python = service.python;
    await save(job);
    try {
      const inputPath = job.workPath + '/recording';
      await copy({ sourceHostId: job.input.inputHostId, sourcePath: job.input.inputPath,
        targetHostId: service.hostId, targetPath: inputPath });
      job.leaseToken = randomUUID(); job.leasePath = job.workPath + '/.lease.json';
      job.leaseExpiresAt = Date.now() + (await settings.get()).leaseSeconds * 1000;
      await host.call('lease', { path: job.leasePath, token: job.leaseToken, expiresAt: job.leaseExpiresAt, create: true }, { hostId: service.hostId });
      job.lastHeartbeatAt = Date.now();
      const argv = [service.python ?? 'python3', service.repoPath + '/run_service.py', inputPath,
        '--out-dir', job.workPath, '--engine', job.input.engine, '--lease-file', job.leasePath, '--lease-token', job.leaseToken];
      if (!job.input.speakers) argv.push('--no-speakers');
      if (job.input.outputs?.audio) argv.push('--audio');
      if (job.input.outputs?.segments) argv.push('--segments');
      if (job.input.outputs?.samples) argv.push('--samples');
      if (job.input.speakerCount) argv.push('--speaker-count',String(job.input.speakerCount));
      // The deterministic ID prevents a duplicate launch after an uncertain create response.
      const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
      const hash = createHash('sha256').update(job.id + ':' + job.attempts.length).digest();
      job.terminalId = 'term_' + [...hash.subarray(0,10)].map(b => alphabet[b % alphabet.length]).join('');
      if ((await kv.get('job:' + job.id))?.state === 'cancelled') return;
      job.state = 'starting'; await save(job);
      const terminal = await bb.sdk.terminals.create({ id: job.terminalId, scope: { kind: 'host_path', hostId: service.hostId, cwd: service.repoPath },
        cols: 160, rows: 40, title: 'Transcribe ' + job.id, start: { mode: 'argv', argv } });
      job.terminalId = terminal.id; job.state = 'running'; await save(job);
    } catch (error) {
      if (job.state === 'starting' && !/HTTP (400|401|403|404|422):/.test(String(error))) {
        // Keep the terminal identity: a lost response does not prove the process never started.
        job.connectionError = String(error); await save(job);
      } else { await failAttempt(job, error); }
    }
  }
  async function tick(job) {
    if (job.state === 'queued') return prepare(job);
    if (job.state === 'preparing') {
      job.state = 'interrupted'; job.error = 'Reload interrupted preparation. Source is intact; submit a new job after inspection.';
      return save(job);
    }
    if (['running','starting'].includes(job.state)) {
      let terminal;
      try { terminal = await bb.sdk.terminals.get({ terminalId: job.terminalId }); }
      catch (error) { job.connectionError = String(error); }
      if (!terminal || terminal.status !== 'exited') {
        if (job.leaseExpiresAt && Date.now() > job.leaseExpiresAt + 10000) {
          await bb.sdk.terminals.close({ terminalId: job.terminalId, mode: 'force' }).catch(() => null);
          return failAttempt(job, 'Executor lease expired after loss of contact; the old attempt is fenced and stops when the machine wakes');
        }
        if (job.leasePath && Date.now() - job.lastHeartbeatAt >= 15000) {
          try {
            const expiresAt = Date.now() + (await settings.get()).leaseSeconds * 1000;
            const renewed = await host.call('lease', { path: job.leasePath, token: job.leaseToken, expiresAt, create: false }, { hostId: job.serviceHostId });
            if (!renewed) {
              await bb.sdk.terminals.close({ terminalId: job.terminalId, mode: 'force' }).catch(() => null);
              return failAttempt(job, 'Executor lease expired or was invalidated');
            }
            job.leaseExpiresAt = expiresAt; job.lastHeartbeatAt = Date.now(); delete job.connectionError;
            try {
              const data = await host.call('read', { path: job.workPath + '/progress.json', offset: 0, size: 65536 }, { hostId: job.serviceHostId });
              job.progress = JSON.parse(Buffer.from(data,'base64').toString('utf8'));
            } catch { /* Older workers may have no progress file. */ }
          } catch (error) { job.connectionError = String(error); }
        }
        if (terminal) job.state = 'running';
        await save(job); return;
      }
      if (terminal.exitCode === null) {
        job.state = 'interrupted'; job.error = 'Terminal closed without a confirmed exit code; no automatic rerun';
        await save(job); return;
      }
      if (terminal.exitCode !== 0) {
        const output = await bb.sdk.terminals.output({ terminalId: job.terminalId, tailBytes: 4000 }).catch(() => null);
        return failAttempt(job, JSON.stringify(output ?? { exitCode: terminal.exitCode }));
      }
      try {
        const encoded = await host.call('read', { path: job.workPath + '/result.json', offset: 0, size: 65536 }, { hostId: job.serviceHostId });
        job.diagnostics = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).diagnostics ?? {};
      } catch { job.diagnostics = {}; }
      job.state = 'returning'; await save(job);
    }
    if (job.state === 'returning') {
      if (job.deliveryRetryAt && Date.now() < job.deliveryRetryAt) return;
      job.deliveryDeadlineAt ??= Date.now() + 600000;
      try {
        job.returned ??= {};
        const destinations = { transcript: job.input.outputPath, ...(job.input.outputs ?? {}) };
        const names = { transcript: 'transcript.txt', segments: 'diarization.json', audio: 'audio.m4a', source: 'recording', samples: 'speaker-samples.zip' };
        for (const [kind, targetPath] of Object.entries(destinations)) {
          if (job.returned[kind]) continue;
          job.returned[kind] = await copy({ sourceHostId: job.serviceHostId, sourcePath: job.workPath + '/' + names[kind],
            targetHostId: job.input.outputHostId, targetPath, allowExistingMatch: true });
          await save(job);
        }
        job.state = 'completed';
        job.result = { hostId: job.input.outputHostId, ...job.returned.transcript, artifacts: job.returned, diagnostics: job.diagnostics ?? {} };
        delete job.connectionError; delete job.deliveryError; delete job.deliveryRetryAt;
      } catch (error) {
        // Recognition succeeded; keep all original artifacts and never recognize again to retry a delivery.
        const message = String(error);
        const transient = /timed out|timeout|disconnected|not connected|connection|generation.*retired|worker.*exit|unreachable|fetch failed/i.test(message);
        job.state = transient && Date.now() < job.deliveryDeadlineAt ? 'returning' : 'return_failed';
        job.deliveryError = message;
        if (job.state === 'returning') job.deliveryRetryAt = Date.now() + 15000;
        else job.error = message;
        job.result = { hostId: job.serviceHostId, path: job.workPath + '/transcript.txt',
          workPath: job.workPath, delivered: job.returned ?? {} };
      }
      await save(job);
    }
  }
  async function cancel({ jobId }) {
    const job = await status({ jobId });
    if (['completed','failed','return_failed','cancelled'].includes(job.state)) return job;
    job.state = 'cancelled'; await save(job);
    if (job.terminalId) await bb.sdk.terminals.close({ terminalId: job.terminalId, mode: 'force' }).catch(() => null);
    return job;
  }
  async function retryDelivery({ jobId }) {
    const job = await status({ jobId });
    if (job.state !== 'return_failed') throw new Error('Only a failed delivery can be retried');
    job.state = 'returning'; job.deliveryRetryAt = Date.now(); job.deliveryDeadlineAt = Date.now() + 600000;
    delete job.error; await save(job); return { jobId, state: job.state };
  }
  async function prepareWorkers({force=false}={}) {
    const list = await services();
    for (const service of list) {
      if (!service.connected || !service.runtimePath || !service.needsSetup || service.busy) continue;
      const key='setup:'+service.hostId+':'+service.requirementsHash;
      let setup=await kv.get(key);
      if(setup?.terminalId) {
        try {
          const terminal=await bb.sdk.terminals.get({terminalId:setup.terminalId});
          if(terminal.status!=='exited')continue;
          if(!force) {setup.status='failed';setup.exitCode=terminal.exitCode;await kv.set(key,setup);continue;}
        } catch(error) {if(!force){setup.status='unknown';setup.error=String(error);await kv.set(key,setup);continue;}}
      }
      const attempt=(setup?.attempt ?? 0)+1;
      const alphabet='23456789abcdefghijkmnpqrstuvwxyz';
      const hash=createHash('sha256').update(key+':'+attempt).digest();
      const terminalId='term_'+[...hash.subarray(0,10)].map(b=>alphabet[b%alphabet.length]).join('');
      setup={status:'starting',terminalId,attempt,environmentPath:service.environmentPath,runtimeVersion:service.runtimeVersion};
      await kv.set(key,setup);
      const argv=['python3',service.runtimePath+'/scripts/setup_worker.py','--venv',service.environmentPath,'--requirements-id',service.requirementsHash,'--download-model'];
      if(service.platform==='linux' || service.platform==='Linux')argv.push('--cpu');
      if(service.platform==='darwin' || service.platform==='Darwin')argv.push('--reuse-system-packages');
      try {
        const terminal=await bb.sdk.terminals.create({id:terminalId,scope:{kind:'host_path',hostId:service.hostId,cwd:service.runtimePath},cols:160,rows:40,title:'Local Transcribe worker setup',start:{mode:'argv',argv}});
        setup.terminalId=terminal.id;setup.status='installing';await kv.set(key,setup);
      } catch(error) {setup.status='unknown';setup.error=String(error);await kv.set(key,setup);}
    }
    return services();
  }
  async function migrationSnapshot() {
    migrationPaused=true;
    const keys=await kv.list('job:');const jobs=await Promise.all(keys.map(key=>kv.get(key)));
    if(jobs.some(job=>['queued','preparing','starting','running','returning'].includes(job.state))){migrationPaused=false;throw new Error('Wait for active jobs before migrating');}
    migrationPaused=true;
    const entries=await Promise.all((await kv.list()).filter(key=>key.startsWith('job:')||key.startsWith('setup:')).map(async key=>({key,value:await kv.get(key)})));
    return {version:1,settings:await settings.get(),entries};
  }
  async function migrationRestore(snapshot) {
    for(const entry of snapshot.entries) {
      if(!entry.key.startsWith('job:')&&!entry.key.startsWith('setup:'))throw new Error('Invalid migration key');
      await kv.set(entry.key,entry.value);
    }
    await settings.experimental_set(snapshot.settings);migrationPaused=false;
    return {restored:snapshot.entries.length};
  }
  bb.rpc.register(rpcContract, { migrationSnapshot, migrationRestore, services, submit, status, copy, cancel, retryDelivery, prepareWorkers }, {
    experimental_discoverable: true,
    experimental_description: 'Local transcription service discovery, queued jobs with caller-defined primary/fallback hosts, status and binary transfer.',
  });
  const tools = [
    ['local_transcribe_retry_delivery', 'Retry delivery of existing completed artifacts after a temporary connection problem. Never repeats recognition.', z.object({ jobId: z.string() }).strict(), retryDelivery],
    ['local_transcribe_cancel', 'Cancel a transcription job without starting a fallback service.', z.object({ jobId: z.string() }).strict(), cancel],
    ['local_transcribe_services', 'List enrolled machines and their transcription service readiness, device, missing dependencies and busy state.', z.object({}).strict(), () => services()],
    ['local_transcribe_submit', 'Queue local transcription. Prefer Mac; specify fallback host IDs, self or available for automatic fallback. Returns jobId; poll status. No cloud service is selected implicitly.', submitSchema, submit],
    ['local_transcribe_status', 'Read transcription job progress and result. A waiting/disconnected terminal does not start another job.', z.object({ jobId: z.string() }).strict(), status],
    ['local_transcribe_copy', 'Copy a file between enrolled machines in bounded chunks with SHA-256 verification and without replacing an existing file.', rpcContract.copy.input, copy],
  ];
  for (const [name, description, parameters, execute] of tools) {
    bb.agents.registerTool({ name, description, parameters, async execute(input, context) {
      return JSON.stringify(await execute(input, context));
    } });
  }
  bb.agents.contributeInstructions(() => 'Для расшифровки записи и итогов встречи используй навык local-transcribe и local_transcribe_services. Основной исполнитель по умолчанию Mac; по умолчанию запасные — self, затем available: текущая машина и остальные готовые сервисы. Вызов может переопределить fallback. Используй только готовые сервисы. Не отправляй запись в облачный ASR без выбранного пользователем сервиса.');
  bb.background.service('worker-environments',{async start(signal) {
    while(!signal.aborted) {
      try {if((await settings.get()).autoSetup)await prepareWorkers();}catch(error){bb.log.warn(String(error));}
      try {await delay(30000,undefined,{signal});}catch{break;}
    }
  }});
  bb.background.service('transcription-jobs', { async start(signal) {
    while (!signal.aborted) {
      try {
        const keys = await kv.list('job:');
        const jobs = (await Promise.all(keys.map(k => kv.get(k))))
          .filter(j => ['queued','preparing','starting','running','returning'].includes(j.state))
          .filter(j => !j.workerRetryAt || Date.now() >= j.workerRetryAt)
          .filter(j => j.state !== 'returning' || !j.deliveryRetryAt || Date.now() >= j.deliveryRetryAt)
          .sort((a,b) => Number(a.state === 'queued') - Number(b.state === 'queued') || a.createdAt - b.createdAt);
        if (jobs.length && !signal.aborted) await tick(jobs[0]);
      } catch (error) { bb.log.error(String(error)); }
      try { await delay(1500, undefined, { signal }); } catch { break; }
    }
  } });
}
