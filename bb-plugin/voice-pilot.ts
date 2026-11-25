import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { encryptionKey, openVoiceRegistry, suggestVoice } from './voice-registry.js';

const jobIdSchema = z.object({ jobId: z.string().uuid() }).strict();
const reviewSchema = jobIdSchema.extend({
  speaker: z.number().int().min(0).max(255),
  proposedName: z.string().trim().min(1).max(96).optional(),
}).strict();
const forgetSchema = z.object({ profileId: z.string().uuid() }).strict();
const answerSchema = z.object({
  profileId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(96).regex(/^[\p{L}\p{M}\p{N} .’'()-]+$/u).optional(),
  saveVoice: z.boolean().default(false),
  consent: z.boolean().default(false),
  allowAcrossProjects: z.boolean().default(false),
  transferConsent: z.boolean().default(false),
}).strict().refine(value => Boolean(value.name) !== Boolean(value.profileId));
const vectorSchema = z.array(z.number().min(-1).max(1)).length(192)
  .refine(values => Math.abs(values.reduce((sum, x) => sum + x * x, 0) - 1) < 0.01);
const featuresSchema = z.object({
  encoder: z.string().regex(/^campplus:[a-f0-9]{64}:pcm16-s16le-v1:192$/).optional(),
  examples: z.array(z.object({start: z.number().nonnegative(), vector: vectorSchema})).max(3),
}).refine(features => !features.examples.length || Boolean(features.encoder));

const formTimeoutMs = 10 * 60_000;

export function registerVoicePilot(bb, {settings, host, kv}) {
  // Active forms own the only capabilities for review audio. Closing a form
  // releases the sample bytes and revokes the link immediately.
  const previews = new Map();
  let registry;
  let voiceConfigKey;

  async function access(projectId: string) {
    const config = await settings.get();
    const projects = z.array(z.string()).parse(JSON.parse(config.voicePilotProjects ?? '[]'));
    if (!projectId || !projects.includes(projectId)) throw new Error('Voice review is not enabled for this project');
    const key = encryptionKey(config.voiceRegistryKey);
    if (!registry || voiceConfigKey !== config.voiceRegistryKey) {
      registry = openVoiceRegistry(bb.storage, key);
      voiceConfigKey = config.voiceRegistryKey;
    }
    return registry;
  }
  async function jobFor({jobId}, {projectId, threadId}) {
    if (!threadId || !projectId) throw new Error('Voice review needs the source BB thread');
    const job = await kv.get('job:' + jobId);
    if (!job || job.state !== 'completed' || !job.input?.speakers ||
        job.threadId !== threadId || job.sourceProjectId !== projectId ||
        !job.serviceHostId || !job.workPath || !job.runtimePath || !job.python) {
      throw new Error('Completed speaker job is unavailable in this thread');
    }
    const thread = await bb.sdk.threads.get({threadId});
    const environmentId = thread.environmentId ?? thread.thread?.environmentId;
    if (!environmentId || (await bb.sdk.environments.get({environmentId})).projectId !== projectId) {
      throw new Error('The source thread is no longer in this project');
    }
    return job;
  }
  const featureArgs = job => ({
    recording: job.workPath + '/recording',
    segments: job.workPath + '/diarization.json',
    script: job.runtimePath + '/voice_features.py',
    python: job.python,
  });
  const getFeatures = (job, speaker?) => host.call('voiceFeatures', {
    ...featureArgs(job), ...(speaker === undefined ? {} : {speaker}),
  }, {hostId: job.serviceHostId});

  async function voiceMap(input, context) {
    const store = await access(context.projectId);
    const job = await jobFor(input, context);
    const confirmed = store.labels(input.jobId);
    let slots = [];
    let pendingUnavailable = false;
    try {
      slots = z.array(z.object({speaker:z.number().int(),hasSample:z.boolean()})).max(256)
        .parse(await getFeatures(job));
    } catch {
      pendingUnavailable = true;
    }
    return {jobId: input.jobId, originalTranscript: job.result?.path, confirmed, pendingUnavailable,
      pending: slots.filter(slot => !confirmed.some(label => label.speaker === slot.speaker)),
      prompt: 'Для каждого подходящего неизвестного спикера открой форму с отрывком: «Говорящий N — кто?»'};
  }

  async function review(input, context) {
    let store = await access(context.projectId);
    let job = await jobFor(input, context);
    const previous = store.label(input.jobId, input.speaker);
    // Check that an existing label can be corrected even if its original
    // worker is temporarily offline.
    let features = {examples: []};
    try {
      features = featuresSchema.parse(await getFeatures(job, input.speaker));
    } catch {
      if (!previous) throw new Error('Unable to prepare the speaker sample on the executor');
    }
    if (!features.examples.length && !previous) return { outcome: 'no-clean-sample', speaker: input.speaker };
    const profiles = store.profiles();
    const suggestion = suggestVoice(profiles, features, context.projectId);
    const choices = profiles.filter(profile => profile.projects.includes(context.projectId))
      .map(profile => ({id:profile.id, name:profile.name}));
    if (suggestion?.crossProject) choices.unshift({ ...suggestion });
    const token = features.examples.length ? randomBytes(32).toString('base64url') : undefined;
    if (token && previews.size >= 20) throw new Error('Too many open voice reviews; close a form and retry');
    const sample = token ? {
      jobId: input.jobId, projectId: context.projectId, threadId: context.threadId,
      start: features.examples[0].start, expires: Date.now() + formTimeoutMs,
    } : undefined;
    // RequestInput detaches from the agent turn while waiting on an actual user.
    if (token) previews.set(token, sample);
    let result;
    try {
      result = await bb.ui.requestInput({
        threadId: context.threadId, rendererId: 'voice-review',
        title: previous ? `Уточнить: говорящий ${input.speaker}` : `Говорящий ${input.speaker} — кто?`,
        timeoutMs: formTimeoutMs,
        payload: {
          audio: token ? '/api/v1/plugins/local-transcribe/http/voice-sample?review=' + token : null,
          choices, suggestionId: suggestion?.id ?? null, tentative: !!suggestion?.tentative,
          name: input.proposedName ?? previous?.name ?? '',
        },
        describeSubmission: () => ({title:'Ответ о говорящем получен'}),
      }, {signal:context.signal});
    } finally {
      if (token) previews.delete(token);
    }
    if (result.outcome !== 'submitted') return {outcome:'skipped', speaker:input.speaker};
    const answer = answerSchema.parse(result.value);
    if (answer.saveVoice && !answer.consent) throw new Error('Explicit speaker consent is required to save a voice profile');
    if (answer.profileId && !choices.some(item => item.id === answer.profileId)) throw new Error('Profile was not offered in the review');
    const transfer = !!suggestion?.crossProject && suggestion.id === answer.profileId;
    if (transfer && !answer.transferConsent) throw new Error('Confirm the first match in this project before attaching it');
    if (context.signal?.aborted) throw new Error('Voice review was cancelled');
    store = await access(context.projectId);
    job = await jobFor(input, context);
    const label = store.confirm({
      jobId: job.id, speaker:input.speaker, revision: previous?.revision, projectId:context.projectId, features,
      threadId: context.threadId, selection: {...answer, permitTransfer: transfer && answer.transferConsent},
    });
    return {outcome:'confirmed', ...label, savedVoice:answer.saveVoice};
  }

  async function render(input, context) {
    const store = await access(context.projectId);
    const job = await jobFor(input, context);
    const confirmed = store.labels(input.jobId);
    if (!confirmed.length) throw new Error('There are no confirmed speaker names for this recording');
    if (!job.result?.path || !job.result.hostId) throw new Error('The original transcript is unavailable');
    const filename = `voice-labels-${input.jobId}-${randomUUID()}.txt`;
    const path = await host.call('voiceRender', {
      source: job.result.path, filename,
      labels: confirmed.map(({speaker,name}) => ({speaker,name})),
    }, {hostId:job.result.hostId});
    return {path, hostId:job.result.hostId, confirmed:confirmed.length};
  }

  async function forget(input, context) {
    let store = await access(context.projectId);
    const profile = store.profiles().find(person => person.id === input.profileId && person.projects.includes(context.projectId));
    if (!profile || !context.threadId) throw new Error('Profile is not available in this project');
    const answer = await bb.ui.requestInput({
      threadId: context.threadId, rendererId:'voice-forget', title:'Удалить голосовой профиль?',
      timeoutMs:formTimeoutMs, payload:{name:profile.name},
    }, {signal:context.signal});
    if (answer.outcome !== 'submitted' || answer.value !== true || context.signal?.aborted) return {outcome:'skipped'};
    store = await access(context.projectId);
    store.forget(profile.id, context.projectId);
    return {outcome:'deleted'};
  }

  async function profiles(_input, context) {
    const store = await access(context.projectId);
    return store.profiles().filter(profile => profile.projects.includes(context.projectId))
      .map(profile => ({id:profile.id, name:profile.name}));
  }

  for (const [name, description, parameters, execute] of [
    ['local_transcribe_voice_map','Read confirmed speaker names and pending five-second reviews for a completed job in its source thread.', jobIdSchema, voiceMap],
    ['local_transcribe_voice_review','Open a human confirmation form for an unknown or incorrectly named speaker. Use the numeric Speaker ID from the transcript. This waits for the user; do not infer identity from the voice or submit an answer for the user.', reviewSchema, review],
    ['local_transcribe_voice_profiles','List voice profile names available in the current project so the user can choose which profile to forget.', z.object({}).strict(), profiles],
    ['local_transcribe_voice_render','Create a separate transcript with confirmed names for the source job, keeping unidentified speakers and the original transcript unchanged.', jobIdSchema, render],
    ['local_transcribe_voice_forget','Open a human confirmation form to permanently delete a voice profile and its active labels across projects.', forgetSchema, forget],
  ] as const) {
    bb.agents.registerTool({name,description,parameters,async execute(input, context) {
      return JSON.stringify(await execute(input, context));
    }});
  }

  bb.http.route('GET', '/voice-sample', async ctx => {
    const sample = previews.get(ctx.req.query('review'));
    if (!sample || sample.expires <= Date.now()) return new Response(null,{status:404});
    try {
      await access(sample.projectId);
      const job = await jobFor(sample, sample);
      if (!sample.audio) {
        sample.audio = host.call('voiceClip', {
          recording: job.workPath + '/recording', start: sample.start,
        }, {hostId:job.serviceHostId}).then(data => Buffer.from(data,'base64'))
          .catch(error => {sample.audio = undefined;throw error;});
      }
      const wav = await sample.audio;
      // No bytes may be returned after the human closes the form.
      if (sample.expires <= Date.now() || previews.get(ctx.req.query('review')) !== sample) {
        return new Response(null,{status:404});
      }
      return new Response(wav, {headers:{
        'Content-Type':'audio/wav', 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer',
        'X-Content-Type-Options':'nosniff',
      }});
    } catch {
      return new Response(null,{status:404});
    }
  }, {auth:'local'});
}
