import { z } from 'zod';
import { HiveError } from './ops.js';

export const optionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional().describe('Stable lowercase slug. Derived from the label when omitted.'),
  label: z.string().min(1).max(80).describe('Short choice label. Put the recommended option first and suffix its label with (Recommended).'),
  description: z.string().max(300).optional(),
}).strict();
export const optionsSchema = z.array(optionSchema).max(6);
const singleLine = s => s.replace(/\s+/g, ' ').trim();

export function requestOptions(raw = []) {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw new HiveError(`Invalid options: ${parsed.error.message}`, 'invalid');
  const explicit = new Set(raw.map(o => o.id).filter(Boolean)), ids = new Set();
  return raw.map((o, i) => {
    const label = singleLine(o.label);
    if (!label || label.length > 80) throw new HiveError(`options[${i}].label must be nonempty text of at most 80 characters.`, 'invalid');
    let id = o.id;
    if (id && ids.has(id)) throw new HiveError(`options[${i}].id "${id}" is used twice.`, 'invalid');
    if (!id) {
      const taken = c => ids.has(c) || explicit.has(c);
      id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
      if (!id || taken(id)) id = `option-${i + 1}`;
      for (let n = 2; taken(id); n++) id = `option-${i + 1}-${n}`;
    }
    ids.add(id);
    return { id, label, ...(o.description?.trim() ? { description: o.description.trim() } : {}) };
  });
}

const LISTED_IN_PROSE = /^[\s>*_#-]*(?:options|choices)\s*(?:\([^)\n]*\))?\s*[*_]*\s*:/im;
const OPTION_LINES = /^[\s>*_-]*option\s+[a-z0-9]\b\s*[:.)-]/gim;

export function requireOptionsForChoices({ kind, body }, options) {
  if (options.length) return;
  const prose = LISTED_IN_PROSE.test(body) || (body.match(OPTION_LINES) || []).length >= 2;
  if (kind !== 'decision' && !prose) return;
  throw new HiveError('This request offers a choice, so pass the choices as `options` (2-4 items, recommended first with "(Recommended)" in its label) and do not list them in the body. Pass `options` even if your listed hive_request_input schema lacks it: the server accepts it. If your client refuses the field, restart the session without resuming it, or ask an open question with kind "question" and no list of choices in the body.', 'invalid');
}
