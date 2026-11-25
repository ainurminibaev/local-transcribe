import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

type Vector = number[];
type Sample = { encoder: string; source: string; confirmedAt: number; start: number; vector: Vector };
type Profile = { id: string; name: string; projects: string[]; allowAcrossProjects: boolean; samples: Sample[] };
type Label = { profileId: string | null; name: string; revision: string; confirmedAt: number; projectId: string; threadId: string };
type Example = { start: number; vector: Vector };
export type Features = { encoder?: string; examples: Example[] };

export function encryptionKey(value?: string) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('Set a 32-byte voice registry key in the secret BB setting');
  return Buffer.from(value, 'hex');
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cosine(a: Vector, b: Vector) {
  if (a.length !== b.length) return -1;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

export function suggestVoice(profiles: Profile[], features: Features, projectId: string) {
  if (!features.encoder || features.examples.length < 2) return undefined;
  for (const crossProject of [false, true]) {
    const eligible = profiles.filter(profile => crossProject
      ? !profile.projects.includes(projectId) && profile.allowAcrossProjects
      : profile.projects.includes(projectId));
    const scores = eligible.flatMap(profile => {
      const references = profile.samples.filter(sample => sample.encoder === features.encoder);
      if (!references.length) return [];
      const windows = features.examples.map(({vector}) => Math.max(...references.map(ref => cosine(ref.vector, vector))));
      return [{ profile, windows, score: median(windows) }];
    }).sort((a, b) => b.score - a.score);
    const [best, next] = scores;
    if (!best) continue;
    const margin = crossProject ? 0.10 : 0.08;
    const floor = crossProject ? 0.85 : 0.80;
    const wins = best.windows.filter((score, index) => score >= floor &&
      scores.slice(1).every(other => score > other.windows[index])).length;
    if (best.score >= floor && wins >= 2 && best.score - (next?.score ?? -1) >= margin) {
      return { id: best.profile.id, name: best.profile.name, crossProject };
    }
    // A plausible in-project match must be reviewed before considering other projects.
    if (!crossProject && best.score >= 0.70) {
      if (best.score - (next?.score ?? -1) >= margin) {
        return { id: best.profile.id, name: best.profile.name, crossProject, tentative: true };
      }
      return undefined;
    }
  }
}

const migrations = [
  'CREATE TABLE IF NOT EXISTS voice_profiles(id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS voice_labels(
    job_id TEXT NOT NULL, speaker INTEGER NOT NULL, profile_id TEXT,
    payload TEXT NOT NULL, PRIMARY KEY(job_id, speaker)
  )`,
  'CREATE INDEX IF NOT EXISTS voice_labels_profile ON voice_labels(profile_id)',
];

export function openVoiceRegistry(storage, key: Buffer) {
  const db = storage.database();
  storage.migrate(db, migrations);
  db.exec('PRAGMA secure_delete = ON');

  function seal(value, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function unseal(payload: string, aad: string) {
    const bytes = Buffer.from(payload, 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Voice registry cannot be unlocked with the configured key');
    }
  }

  const profiles = (): Profile[] => db.prepare('SELECT id,payload FROM voice_profiles').all()
    .map(row => unseal(row.payload, 'profile:' + row.id));
  const profile = (id: string): Profile | undefined => {
    const row = db.prepare('SELECT payload FROM voice_profiles WHERE id=?').get(id);
    return row ? unseal(row.payload, 'profile:' + id) : undefined;
  };
  const labelKey = (jobId: string, speaker: number) => `label:${jobId}:${speaker}`;
  const label = (jobId: string, speaker: number): Label | undefined => {
    const row = db.prepare('SELECT payload FROM voice_labels WHERE job_id=? AND speaker=?').get(jobId, speaker);
    return row ? unseal(row.payload, labelKey(jobId, speaker)) : undefined;
  };
  const labels = (jobId: string) => db.prepare('SELECT speaker,payload FROM voice_labels WHERE job_id=? ORDER BY speaker').all(jobId)
    .map(row => ({ speaker: row.speaker, name: unseal(row.payload, labelKey(jobId, row.speaker)).name, status: 'confirmed' }));
  function storeProfile(value: Profile) {
    db.prepare('INSERT OR REPLACE INTO voice_profiles(id,payload) VALUES(?,?)')
      .run(value.id, seal(value, 'profile:' + value.id));
  }
  const confirm = db.transaction(({
    jobId, speaker, revision, projectId, threadId, features, selection,
  }: {
    jobId: string; speaker: number; revision?: string; projectId: string; threadId: string; features: Features;
    selection: { name?: string; profileId?: string; permitTransfer?: boolean; saveVoice: boolean; allowAcrossProjects?: boolean };
  }) => {
    const previous = label(jobId, speaker);
    if (previous?.revision !== revision) throw new Error('The speaker label changed while the form was open; review it again');
    const confirmedAt = Date.now();
    const source = `${jobId}:${speaker}`;
    let next = selection.profileId ? profile(selection.profileId) : undefined;
    if (selection.profileId && (!next || (!next.projects.includes(projectId) &&
      !(selection.permitTransfer && next.allowAcrossProjects)))) throw new Error('Profile is no longer available in this project');

    if (!selection.profileId && selection.saveVoice) {
      if (profiles().length >= 500) throw new Error('The voice pilot supports at most 500 profiles');
      next = { id: randomUUID(), name: selection.name!, projects: [], samples: [],
        allowAcrossProjects: selection.allowAcrossProjects === true };
    }
    const name = next?.name ?? selection.name!;
    if (selection.saveVoice && (!features.encoder || !features.examples.length)) {
      throw new Error('No clean voice sample is available');
    }
    if (previous?.profileId && previous.profileId !== next?.id) {
      const prior = profile(previous.profileId);
      if (prior) {
        prior.samples = prior.samples.filter(sample => sample.source !== source);
        storeProfile(prior);
      }
    }

    if (next) {
      if (!next.projects.includes(projectId)) next.projects.push(projectId);
      if (selection.saveVoice) {
        const encoder = features.encoder!;
        // Enroll only the excerpt that was presented in the confirmation form.
        const fresh = features.examples.slice(0, 1).map(({start, vector}) => ({ encoder, source, start, vector, confirmedAt }));
        const retained = next.samples.filter(sample => sample.source !== source);
        next.samples = [...fresh, ...retained.filter(sample => sample.encoder === encoder)].slice(0, 5)
          .concat(retained.filter(sample => sample.encoder !== encoder).slice(0, 10));
      }
      storeProfile(next);
    }
    const value: Label = { name, profileId: next?.id ?? null, revision: randomUUID(), confirmedAt, projectId, threadId };
    db.prepare('INSERT OR REPLACE INTO voice_labels(job_id,speaker,profile_id,payload) VALUES(?,?,?,?)')
      .run(jobId, speaker, value.profileId, seal(value, labelKey(jobId, speaker)));
    return { speaker, name, status: 'confirmed' };
  });
  const remove = db.transaction((id: string, projectId: string) => {
    const current = profile(id);
    if (!current || !current.projects.includes(projectId)) throw new Error('Profile is no longer available in this project');
    db.prepare('DELETE FROM voice_labels WHERE profile_id=?').run(id);
    db.prepare('DELETE FROM voice_profiles WHERE id=?').run(id);
  });
  function forget(id: string, projectId: string) {
    remove(id, projectId);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* The committed deletion remains in effect. */ }
  }
  return { profiles, label, labels, confirm, forget };
}
