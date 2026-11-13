export const DRAFT_PREFIX = 'draft:';
export const DRAFT_TEXT_MAX = 20000;
const DRAFT_KEEP_MAX = 2 * DRAFT_TEXT_MAX;
const EMPTY_DRAFT = Object.freeze({ text: '', title: '', reply: null, about: null, aboutAuto: false, detach: null, rev: '' });
const newRev = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = (v) => (typeof v === 'string' && v && v.length <= 80 ? v : null);

function readDraft(io, key) {
  const got = io.load(`${DRAFT_PREFIX}${key}`, null);
  if (!got || typeof got !== 'object') return null;
  const about = got.aboutAuto === true ? null : got.about === '' ? '' : id(got.about);
  return {
    text: str(got.text, DRAFT_KEEP_MAX),
    title: str(got.title, 200),
    reply: id(got.reply),
    about,
    aboutAuto: false,
    detach: id(got.detach),
    rev: str(got.rev, 40),
  };
}

// The first read of a composer comes from storage. A new-topic composer with
// nothing saved takes over text kept by the single-stream composer.
function draftOf(io, mem, key) {
  if (mem.drafts.has(key)) return mem.drafts.get(key);
  let d = readDraft(io, key);
  if (!d && key.endsWith(':new')) {
    const old = readDraft(io, key.slice(0, -4));
    if (old?.text) {
      d = { ...EMPTY_DRAFT, text: old.text };
      saveDraft(io, key, d);
      saveDraft(io, key.slice(0, -4), null);
    }
  }
  d ||= EMPTY_DRAFT;
  mem.drafts.set(key, d);
  return d;
}

function saveDraft(io, key, d) {
  const empty = !d || (!d.text && !d.title && !d.reply && d.about === null && d.detach === null);
  if (!empty) io.save(`${DRAFT_PREFIX}${key}`, d);
  else if (io.remove) io.remove(`${DRAFT_PREFIX}${key}`);
  else io.save(`${DRAFT_PREFIX}${key}`, null);
}

function putDraft(io, mem, key, d) {
  mem.drafts.set(key, d);
  saveDraft(io, key, d);
}

function editDraft(io, mem, key, patch) {
  const d = draftOf(io, mem, key);
  const next = { ...d, ...patch, rev: newRev() };
  putDraft(io, mem, key, next);
}

// The stored draft is the authority: another tab may have saved a newer one
// that this tab has not heard about yet.
function sameRev(io, mem, key, rev) {
  if (!rev || draftOf(io, mem, key).rev !== rev) return false;
  const stored = readDraft(io, key);
  return !stored || stored.rev === rev;
}

export function createDrafts(io) {
  return {
    draftOf: (mem, key) => draftOf(io, mem, key),
    putDraft: (mem, key, d) => putDraft(io, mem, key, d),
    editDraft: (mem, key, patch) => editDraft(io, mem, key, patch),
    sameRev: (mem, key, rev) => sameRev(io, mem, key, rev),
    newRev,
  };
}
