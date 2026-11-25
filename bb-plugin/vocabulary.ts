import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const glossary = /^(?:glossary|terminology|terms|глоссарий|термины|люди-и-роли)\.(?:md|txt)$/iu;
const summary = /(?:^|[-_ ])(?:итоги|minutes|meeting[-_]analysis)(?:[-_ ].*)?\.(?:md|txt)$/iu;
const transcript = /(?:^|[-_ ])(?:transcript|транскрипт|расшифровка)(?:[-_ ].*)?\.(?:md|txt)$/iu;
const reference = /^(?:agents|project-resources|readme)\.md$/iu;
const omitted = /^(?:\.|_архив$|node_modules$|vendor$|secrets$|dist$|build$|work$|attachments$)/iu;
const privateName = /(?:^|[\s_.-])(?:auth(?:orization)?|credentials?|contacts?|passwords?|secrets?|tokens?|контакты|пароли|доступы|учётки|учетки)(?:[\s_.-]|$)/iu;
const tokenPattern = /[\p{L}][\p{L}\p{M}\p{N}]*(?:[-'][\p{L}\p{M}\p{N}]+)*/gu;
const common = new Set(('agents agent speaker readme markdown transcript workflow tools git npm json sdk http https ' +
  'правила кратко задачи задача решения решение итог итоги обсуждение встреча встречи участники проект проекты команда ' +
  'время дата имя роль должность примечание описание термин название определение значение фио сегодня завтра готово файлы сводка содержание кто что срок статус ответственный шаг пример ' +
  'там здесь когда где так это эти всё все короче конечно понятно пока ну вот или после перед если как почему ' +
  'маркетинг тестировщик разработка инфраструктура управление дополнительно производство сценарии бизнес все-таки давайте спасибо значит вообще хорошо ладно исходное ссылка ссылки раздел заметки заметка ' +
  'overview summary project status notes rule guide contact open done welcome important todo true false none code info name test note manager owner user admin service task policy').split(' '));

const limits = { glossary: 8, reference: 12, text: 16, summary: 12, transcript: 12 } as const;
const weight = { glossary: 10, reference: 5, text: 4, summary: 5, transcript: 1 } as const;
type Kind = keyof typeof limits;
type Source = { path: string; kind: Kind; mtime: number };
type Vote = { term: string; strength: number; groups: Map<string, number> };

function cleanTerm(raw: string) {
  const term = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!/^[\p{L}][\p{L}\p{M}\p{N} .'-]{1,63}$/u.test(term) || /\.\./u.test(term)) return;
  const words = term.match(tokenPattern) ?? [];
  if (!words.length || words.length > 5) return;
  if (words.some(word => /\p{Script=Cyrillic}/u.test(word) && /\p{Script=Latin}/u.test(word))) return;
  if (words.every(word => common.has(word.toLowerCase())) || /^(?:не|см|для|про|по|что|как) /iu.test(term)) return;
  return term;
}

export function normalizeVocabulary(terms: string[]) {
  const unique = new Map<string, string>();
  for (const raw of terms) {
    const term = cleanTerm(raw);
    if (!term) continue;
    const key = term.toLowerCase();
    if (!unique.has(key)) unique.set(key, term);
    if (unique.size === 64) break;
  }
  return [...unique.values()];
}

async function readEvidence(path: string, kind: Kind) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return '';
    const buffer = Buffer.alloc(64 * 1024);
    const headSize = kind === 'transcript' ? 32 * 1024 : buffer.length;
    const head = await file.read(buffer, 0, headSize, 0);
    if (kind !== 'transcript' || info.size <= headSize) return buffer.subarray(0, head.bytesRead).toString('utf8');
    // Take a sample near the end as well: attendee names need not appear in the introduction.
    const start = Math.max(headSize, info.size - 32 * 1024);
    const tail = await file.read(buffer, headSize, buffer.length - headSize, start);
    const text = buffer.subarray(headSize, headSize + tail.bytesRead).toString('utf8');
    return buffer.subarray(0, head.bytesRead).toString('utf8') + '\n' + text.slice(text.indexOf('\n') + 1);
  } finally {
    await file.close();
  }
}

function sourceKind(name: string): Kind | undefined {
  if (privateName.test(name)) return;
  if (glossary.test(name)) return 'glossary';
  if (summary.test(name)) return 'summary';
  if (transcript.test(name)) return 'transcript';
  if (reference.test(name)) return 'reference';
  if (/^[^.].+\.(?:md|txt)$/iu.test(name)) return 'text';
}

async function findSources(root: string, excludedRoots: string[]) {
  const folders = [{ path: root, depth: 0 }];
  const sources: Source[] = [];
  let visited = 0;
  for (const { path, depth } of folders) {
    if (visited >= 3000) break;
    if (excludedRoots.some(excluded => relative(excluded, path) === '')) continue;
    if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
    const dir = await opendir(path).catch(() => null);
    if (!dir) continue;
    for await (const item of dir) {
      if (++visited > 3000) break;
      const child = join(path, item.name);
      if (item.isDirectory() && depth < 6 && !omitted.test(item.name) && !privateName.test(item.name) && folders.length < 180) {
        folders.push({ path: child, depth: depth + 1 });
      } else if (item.isFile()) {
        const kind = sourceKind(item.name);
        if (!kind) continue;
        const metadata = await lstat(child).catch(() => null);
        if (metadata?.isFile()) sources.push({ path: child, kind, mtime: metadata.mtimeMs });
      }
    }
  }
  return (Object.keys(limits) as Kind[]).flatMap(kind =>
    sources.filter(source => source.kind === kind).sort((a, b) => {
      const depth = (path: string) => relative(root, path).split(/[/\\]/u).length;
      const byDepth = kind === 'reference' || kind === 'text' ? depth(a.path) - depth(b.path) : 0;
      return byDepth || b.mtime - a.mtime || a.path.localeCompare(b.path, 'ru');
    }).slice(0, limits[kind]));
}

function extractTerms(text: string, kind: Kind) {
  const candidates = new Map<string, number>();
  const add = (raw: string, strength: number) => {
    const term = cleanTerm(raw);
    if (term) candidates.set(term, Math.max(strength, candidates.get(term) ?? 0));
  };
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~|<!--[\s\S]*?-->/gu, '\n')
    .replace(/https?:\/\/\S+|\]\([^\n)]*\)|\S+@\S+/gu, ' ');
  for (let line of prose.split('\n')) {
    line = line.replace(/^\s*(?:Speaker \d+|Говорящий \d+)\s*\[?\d+:\d+(?::\d+)?\]?:?\s*/iu, '');
    if (kind === 'glossary') {
      const cell = /^\s*(?:[-*+]\s+|\|\s*)(.+?)(?:\s*[|:—–]|\s+-\s+|$)/u.exec(line)?.[1];
      if (cell) add(cell.replace(/[*_`]/gu, '').replace(/\s*\(.+\)\s*$/u, ''), 15);
    }
    if (kind !== 'transcript') {
      for (const [, bold, quoted] of line.matchAll(/\*\*([^*]+)\*\*|«([^»]+)»/gu)) {
        const label = bold ?? quoted;
        if (/\p{Lu}/u.test(label) && label.split(/\s+/u).length <= 3) add(label, weight[kind] + 2);
      }
    }
    line = line.replace(/`[^`\n]+`/gu, ' ');
    const words = [...line.matchAll(tokenPattern)];
    for (const [index, match] of words.entries()) {
      const [word] = match;
      if (common.has(word.toLowerCase())) continue;
      const title = /^\p{Lu}[\p{Ll}\p{M}]+$/u.test(word);
      const distinctive = /\p{Ll}\p{Lu}|\p{Lu}{2}|\p{L}-[\p{Lu}\d]/u.test(word);
      const before = line.slice(0, match.index).trimEnd();
      const sentenceStart = !before || /[.!?]$/u.test(before) || /^\s*(?:[-*+#>|]+|\d+[.)])\s*$/u.test(before);
      const visible = distinctive || (title && (!sentenceStart || kind === 'glossary'));
      if (visible) add(word, weight[kind]);
      const next = words[index + 1];
      if (next && title && /^\p{Lu}[\p{Ll}\p{M}]+$/u.test(next[0]) &&
          /^\s+$/u.test(line.slice(match.index + word.length, next.index))) {
        add(word + ' ' + next[0], weight[kind] + (kind === 'transcript' ? 0 : 1));
      }
    }
  }
  return candidates;
}

export async function projectVocabulary(root: string, excludedRoots: string[] = []) {
  if (excludedRoots.some(other => relative(other, root) === '')) return [];
  if (!(await lstat(root).catch(() => null))?.isDirectory()) return [];
  const sources = await findSources(root, excludedRoots);
  const evidence = await Promise.all(sources.map(source => readEvidence(source.path, source.kind).catch(() => '')));
  const votes = new Map<string, Vote>();
  for (const [index, source] of sources.entries()) {
    const date = relative(root, source.path).match(/\d{4}-\d{2}-\d{2}/u)?.[0];
    // Speaker variants of the same recorded meeting count as one source.
    const group = source.kind === 'transcript' ? (date ?? dirname(source.path)) : source.path;
    for (const [term, strength] of extractTerms(evidence[index], source.kind)) {
      const key = term.toLowerCase();
      const vote = votes.get(key) ?? { term, strength, groups: new Map() };
      if (strength > vote.strength) {
        vote.term = term;
        vote.strength = strength;
      }
      vote.groups.set(group, Math.max(strength, vote.groups.get(group) ?? 0));
      votes.set(key, vote);
    }
  }
  // A word seen only in raw ASR must recur in two independent recordings.
  const rank = (vote: Vote) => vote.strength * 2 + Math.min(8, vote.groups.size) * 2;
  const ranked = [...votes.values()]
    .filter(vote => vote.strength > 1 || vote.groups.size >= 2)
    .sort((a, b) => rank(b) - rank(a) || a.term.localeCompare(b.term, 'ru'));
  const explicit = ranked.filter(vote => vote.strength >= 15).slice(0, 24);
  // A nominative bonus must not force an already correct oblique form to the
  // nominative. Include regular -а forms for up to four curated single names.
  const caseForms = explicit.map(({term}) => term)
    .filter(term => /^[А-ЯЁ][а-яё]{2,}[бвгдзклмнпрстфх]а$/u.test(term)).slice(0, 4)
    .flatMap(term => {
      const stem = term.slice(0, -1);
      const genitive = /[гкх]$/u.test(stem) ? 'и' : 'ы';
      return [stem + 'ой', stem + genitive, stem + 'е', stem + 'у'];
    });
  // Technical names written in Latin have a separate slot, so attendee lists
  // cannot push all the project brands out of the vocabulary.
  const latin = ranked.filter(({term, groups}) =>
    /^[A-Z][A-Za-z0-9]+(?:[- ][A-Za-z0-9]+){0,2}$/u.test(term) && groups.size >= 2);
  const shortAcronym = ({term}: Vote) => /^[A-Z]{2,3}$/u.test(term);
  const technical = [
    ...latin.filter(vote => !shortAcronym(vote)).slice(0, 20),
    ...latin.filter(vote => shortAcronym(vote) && vote.groups.size >= 3).slice(0, 4),
  ];
  return normalizeVocabulary([
    ...explicit.map(vote => vote.term),
    ...caseForms,
    ...technical.map(vote => vote.term),
    ...ranked.map(vote => vote.term),
  ]);
}
