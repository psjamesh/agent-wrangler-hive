import * as ops from './ops.js';
import { workTools } from './tools.js';
import * as requests from './requests.js';
import { recordHumanInput } from './conversation.js';

const SID = {
  queen: '11111111-1111-4111-8111-111111111111',
  search: '22222222-2222-4222-8222-222222222222',
  cover: '33333333-3333-4333-8333-333333333333',
  reviewer: '44444444-4444-4444-8444-444444444444',
};
const FIELD_TASK = 't_field001';
const HEX = (n) => String(n).repeat(40).slice(0, 40);

export const seedHandler = {
  type: 'hive-capture-seed',
  async handler(msg, host, reply) {
    const log = [];
    const rt = host.stores.hive;
    const tool = (name) => workTools.find(t => t.name === name);
    const call = async (name, caller, args) => {
      const out = await tool(name).handler({ host, caller }, args);
      if (out.isError) throw new Error(`${name}: ${out.content[0].text}`);
      return out.structuredContent;
    };
    const step = async (name, fn) => {
      try { const v = await fn(); log.push(`ok ${name}`); return v; } catch (err) { log.push(`FAIL ${name}: ${err.message}`); throw err; }
    };
    try {
      if (msg?.phase === 'finish') {
        const cell = rt.metadata.cells().find(c => c.queenSessionId === SID.queen);
        const beadOf = (t) => Object.values(rt.snapshots.graph.beads).find(x => x.title === t)?.id;
        const bid = beadOf('Build search');
        await call('hive_finish_bead', SID.search, { cell_id: cell.id, bead_id: bid, outcome: 'done', summary: 'Species search is reviewed and merged. The site rebuild is delegated to the automatic deploy; confirming it is live remains with the queen.', evidence: [{ label: 'Delivery boundary', kind: 'note', detail: 'Merged and reviewed. Installation: the site rebuilds from main automatically; the queen verifies it is live.' }] });
        return reply({ ok: true, finished: bid });
      }
      if (rt.beads.status.state !== 'ready') await rt.initializeStore();
      const adopt = async (taskId, goal, acceptance) => (await ops.adoptTask(rt, host, { taskId, goal, acceptance })).cellId;
      const cellId = await step('adopt field guide', () => adopt(FIELD_TASK,
        'Publish a printed and online field guide to local wildflowers, with a launch event, by the end of spring.',
        'The guide is printed, the website is live with species search, and the launch event has run.'));
      await step('other hives', async () => {
        await adopt('t_garden01', 'Turn the vacant lot into a shared community garden.', 'Beds built, volunteers rostered, first planting done.');
        await adopt('t_cafe0001', 'Give the repair cafe a clear website with booking.', 'New site live and bookings open.');
      });
      await step('queen', async () => {
        rt.metadata.mutate((d) => ops.recordQueen(d, cellId, SID.queen, Date.now() - 2 * 3600_000, 'capture'));
      });
      const created = await step('beads', async () => {
        const W = (ref, title, goal) => ({ ref, kind: 'workstream', title, goal });
        const T = (ref, parent, title, goal, acceptance) => ({ ref, parent, kind: 'work', title, goal, acceptance });
        return call('hive_create_beads', SID.queen, {
          cell_id: cellId,
          beads: [
            W('content', 'Write the guide', 'Research, write and illustrate the species entries.'),
            W('build', 'Build the website', 'A searchable online edition of the guide.'),
            W('launch', 'Launch', 'Publish the guide and run the launch event.'),
            T('research', 'content', 'Research species list', 'Choose the 60 species the guide covers.', 'A reviewed list of 60 species.'),
            T('entries', 'content', 'Write species entries', 'A short entry and photo brief for each species.', 'All 60 entries drafted.'),
            T('cover', 'content', 'Choose the cover', 'Pick the cover illustration for the printed guide.', 'One cover approved by the editor.'),
            T('search', 'build', 'Build search', 'Let readers find a species by name, colour or habitat.', 'Search returns the right species for the ten sample queries.'),
            T('pages', 'build', 'Lay out the pages', 'Typeset the printed pages from the species entries.', 'A print-ready PDF.'),
            T('publish', 'launch', 'Publish the guide', 'Send the guide to print and open the website.', 'Printed copies delivered and the site live.'),
            T('event', 'launch', 'Plan the launch event', 'Book a venue and invite local groups.', 'Venue booked and invitations sent.'),
          ],
          links: [
            { dependent: 'entries', prerequisite: 'research' },
            { dependent: 'pages', prerequisite: 'entries' },
            { dependent: 'publish', prerequisite: 'search' },
            { dependent: 'publish', prerequisite: 'cover' },
            { dependent: 'event', prerequisite: 'publish', type: 'related' },
          ],
        });
      });
      const ids = created.ids;
      const refs = ['content', 'build', 'launch', 'research', 'entries', 'cover', 'search', 'pages', 'publish', 'event'];
      const B = Object.fromEntries(refs.map((r, i) => [r, Array.isArray(ids) ? ids[i] : ids[r]]));
      log.push(`ids ${JSON.stringify(B)}`);

      await step('research done', async () => {
        await call('hive_claim_bead', SID.cover, { cell_id: cellId, bead_id: B.research });
        await call('hive_finish_bead', SID.cover, { cell_id: cellId, bead_id: B.research, outcome: 'done', summary: 'Sixty species chosen, covering woodland, meadow and hedgerow.', evidence: [{ label: 'Species list approved', kind: 'note', detail: 'Reviewed with the local botany group.' }] });
      });
      await step('cover claim + request', async () => {
        await call('hive_claim_bead', SID.cover, { cell_id: cellId, bead_id: B.cover });
        await call('hive_update_bead', SID.cover, { cell_id: cellId, bead_id: B.cover, summary: 'Three cover illustrations are ready for the editor to compare.', next_action: 'Wait for the editor to choose one.', waiting_for: 'The editor picks a cover.' });
        const req = await call('hive_request_input', SID.cover, {
          cell_id: cellId, bead_id: B.cover, kind: 'decision', blocking: true,
          title: 'Which cover should the printed guide use?',
          body: 'Three illustrations are ready. **Meadow** is the most colourful, **Hedgerow** is the calmest and prints best on recycled paper, and **Foxglove** is a close-up.\n\nPublishing waits for this choice.',
          options: [
            { id: 'meadow', label: 'Meadow', description: 'Colourful wide view' },
            { id: 'hedgerow', label: 'Hedgerow (Recommended)', description: 'Calm, prints well on recycled paper' },
            { id: 'foxglove', label: 'Foxglove', description: 'Single close-up' },
          ],
        });
        const r = req.request || req;
        await call('hive_forward_request', SID.queen, { request_id: r.id, revision: r.revision, route_revision: r.routeRevision ?? r.route_revision, recommendation: 'Hedgerow: it reads best at small sizes and keeps the printing cost down.' });
        rt.metadata.mutate((d) => { const q = d.requests?.[r.id]; if (q) q.queenNotification = { state: 'delivered', attempts: [] }; });
      });
      await step('search work', async () => {
        await call('hive_claim_bead', SID.search, { cell_id: cellId, bead_id: B.search });
        await call('hive_update_bead', SID.search, { cell_id: cellId, bead_id: B.search,
          summary: 'Species search works by name, colour and habitat. Reviewed, merged and the site deploys automatically.',
          next_action: 'Confirm the new search is live on the site.',
          waiting_for: 'The site deploy to finish; the queen confirms it is live.',
          add_evidence: [
            { label: 'Pull request: species search', kind: 'pr', url: 'https://example.com/field-guide/pull/12', detail: 'Adds search by name, colour and habitat.' },
            { label: 'Checks passed on 7d1c2a9', kind: 'test', url: 'https://example.com/field-guide/pull/12/checks', detail: 'Unit tests 48 passed, 0 failed. Ten sample queries return the expected species.' },
            { label: 'Merged into main', kind: 'merge', url: 'https://example.com/field-guide/pull/12', merged_head: HEX('7'), detail: 'Merge commit `4be90f1`. Required checks passed on the approved head.' },
            { label: 'Installation handed to the site deploy', kind: 'note', detail: 'The site rebuilds from main automatically. Remaining: confirm it is live. Owner: the queen. Not yet verified.' },
          ] });
      });
      await step('review', async () => {
        await call('hive_bind_session', SID.queen, { cell_id: cellId, bead_id: B.search, session_id: SID.reviewer, role: 'review' });
        await call('hive_review_verdict', SID.reviewer, { cell_id: cellId, bead_id: B.search, verdict: 'approved', commit: HEX('7'), summary: 'Approved at 7d1c2a9. Search matches names, colours and habitats; the ten sample queries pass and an empty query is handled.' });
      });
      await step('conversation', async () => {
        const topic = await call('hive_publish', SID.queen, { cell_id: cellId, bead_id: B.cover, thread_title: 'Cover choice and launch date', text: 'Search is merged and the site rebuild is running. **The cover is the last thing between us and publishing.** I recommend Hedgerow; the request is waiting for you in Needs you.' });
        const threadId = topic.thread_id || topic.threadId;
        const saved = await recordHumanInput(rt, { cellId, text: 'Thanks. Can we keep the launch on the first Saturday of May?', beadId: B.event, threadId });
        rt.metadata.mutate((d) => { const m = d.conversation[cellId].find(x => x.id === saved.id); if (m) m.delivery = { state: 'delivered', sessionId: SID.queen, attempts: [], at: Date.now() }; });
        await call('hive_publish', SID.queen, { cell_id: cellId, bead_id: B.event, reply_to: saved.id, text: 'Yes. The venue holds that Saturday and I have started the invitations once the cover is chosen.' });
      });
      reply({ ok: true, cellId, beads: B, log });
    } catch (err) {
      reply({ ok: false, error: err.message, log, stack: String(err.stack).split('\n').slice(0, 5).join(' | ') });
    }
  },
};
