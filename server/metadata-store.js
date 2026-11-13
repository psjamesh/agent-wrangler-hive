import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hivePaths } from './data-dir.js';
import { RuntimeLifetime } from './lifetime.js';

export const METADATA_SCHEMA = 1;
const OPERATION_CAP = 500;

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export class MetadataUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'metadata-unavailable';
  }
}

function emptyDoc() {
  return {
    schema: METADATA_SCHEMA,
    cells: {},
    launches: {},
    workerLaunches: {},
    reviews: {},
    operations: {},
    bindings: {},
    beadLayout: {},
    regionLayout: {},
    arrangeAspect: {},
    workstreamColours: {},
    workstreamShades: {},
    requests: {},
    conversation: {},
    threads: {},
    inbox: {},
    archived: {},
    restoreNotices: {},
    restoring: {},
    prLabels: {},
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readDoc(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { doc: emptyDoc(), error: null };
    return { doc: emptyDoc(), error: `Hive metadata at ${file} could not be read: ${err.message}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { doc: emptyDoc(), error: `Hive metadata at ${file} is not valid JSON (${err.message}). It has been left untouched; repair or move it, then restart.` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { doc: emptyDoc(), error: `Hive metadata at ${file} is not a JSON object. It has been left untouched.` };
  }
  if (raw.schema !== METADATA_SCHEMA) {
    return { doc: emptyDoc(), error: `Hive metadata at ${file} has schema ${JSON.stringify(raw.schema)}; this Hive version reads schema ${METADATA_SCHEMA}. It has been left untouched.` };
  }
  if (raw.requests !== undefined && (!raw.requests || typeof raw.requests !== 'object' || Array.isArray(raw.requests) || Object.entries(raw.requests).some(([id, r]) => !r || r.id !== id || !/^hreq_[0-9a-f]{12}$/.test(id) || !['open', 'answered', 'resolved'].includes(r.state) || typeof r.body !== 'string' || typeof r.cellId !== 'string'))) return { doc: emptyDoc(), error: 'Hive native request metadata is invalid. It has been left untouched; repair it, then restart.' };
  const doc = { ...emptyDoc(), ...raw };
  for (const key of Object.keys(emptyDoc())) {
    if (key !== 'schema' && (!doc[key] || typeof doc[key] !== 'object' || Array.isArray(doc[key]))) doc[key] = {};
  }
  return { doc, error: null };
}

function pruneOperations(doc) {
  const ids = Object.keys(doc.operations);
  if (ids.length <= OPERATION_CAP) return;
  const settled = ids
    .map((id) => doc.operations[id])
    .filter((op) => ['applied', 'error', 'resolved', 'not-applied'].includes(op.state))
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  for (const op of settled.slice(0, ids.length - OPERATION_CAP)) delete doc.operations[op.id];
}

export class MetadataStore {
  constructor({ file = hivePaths().metadataFile, log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.lifetime = new RuntimeLifetime();
    this.version = 0;
    this.epoch = crypto.randomUUID();
    const { doc, error } = readDoc(file);
    this.doc = doc;
    this.error = error;
    if (error) log(`hive: ${error}`);
  }

  get available() {
    return !this.error;
  }

  read() {
    return this.doc;
  }

  mutate(fn) {
    this.lifetime.assertCurrent();
    if (this.error) throw new MetadataUnavailableError(this.error);
    const next = structuredClone(this.doc);
    const result = fn(next);
    pruneOperations(next);
    this.lifetime.assertCurrent();
    writeJsonAtomic(this.file, next);
    this.doc = next;
    this.version += 1;
    return result;
  }

  cell(cellId) {
    return this.doc.cells[cellId] || null;
  }

  cellForTask(taskId) {
    return Object.values(this.doc.cells).find((c) => c.taskId === taskId) || null;
  }

  cells() {
    return Object.values(this.doc.cells);
  }
}
