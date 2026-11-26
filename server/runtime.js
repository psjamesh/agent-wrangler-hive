import { startCiWaits } from './ci-waits.js';
import { observeLinkWaits } from './link-waits.js';
import { createPickupDispatcher } from './pickup.js';
import { createWatchdog } from './watchdog.js';
import { workLimit, helperSlots, hiveWorkIds } from './admission.js';
import { OPEN_REVIEW_STATES } from './review-state.js';
import { reconcileRequests, notifyQueen, notifyResolution, startRequestSubjects, reconcileRequestSubjects } from './requests.js';
import { reconcileInactiveBindings, trackingKey } from './tracking.js';
import { cleanupOrphanAttachments } from './attachments.js';
import { hivePaths } from './data-dir.js';
import { MetadataStore } from './metadata-store.js';
import { createBeadsAdapter } from './beads.js';
import { createSnapshotCache } from './snapshots.js';
import { projectForGraph } from './projection.js';
import { reconcileColours } from './colours.js';
import { migrateRegions } from './region-migration.js';
import { recover, afterWrite } from './recovery.js';
import { threadAllCells } from './conversation.js';
import { reopenUnfinished } from './workstreams.js';
import { createPrLabelSweep } from './pr-label-discovery.js';
import { createKeepAwake, keepAwakeSettings } from './keep-awake.js';

export const BD_PATH_SETTING = 'bdPath';
const KEEP_AWAKE_TICK_MS = 30000;
const LIVE_LAUNCH_STATES = new Set(['reserved', 'binding', 'claimed']);
const LAUNCH_WINDOW_MS = 10 * 60 * 1000;

// Everything Hive keeps for the life of the process, built by the store
// factory before any host façade exists. `attach(host)` happens on activate.
export class HiveRuntime {
  constructor({ settings = null, log = () => {}, env = process.env, keepAwake = {} } = {}) {
    this.paths = hivePaths(env);
    this.log = log;
    this.settings = settings;
    this.host = null;
    this.metadata = new MetadataStore({ file: this.paths.metadataFile, log });
    this.beads = createBeadsAdapter({
      workspaceDir: this.paths.beadsWorkspace,
      homeDir: this.paths.bdHome,
      scratchDir: this.paths.scratch,
      env,
      log,
      assertCurrent: () => this.metadata.lifetime.assertCurrent(),
      configuredPath: () => this.configuredPath(),
      onStateChange: (next, how) => this.backendChanged(next, how),
    });
    this._backendReady = false;
    this.snapshots = createSnapshotCache({
      beads: this.beads,
      isCurrent: () => this.metadata.lifetime.isCurrent(),
      onChange: () => {
        if (!this.metadata.lifetime.isCurrent()) return;
        this.migrateRegions();
        this.reconcileColours();
        try { observeLinkWaits(this); } catch (err) { this.log(`hive: could not observe dependency waits: ${err.message}`); }
        this.changed();
        if (this.host) reopenUnfinished(this);
      },
      log,
    });
    this.pendingParticipants = new Map();
    this._projection = { key: '', value: null };
    this.keepAwake = createKeepAwake({
      log,
      onChange: () => {
        if (!this.metadata.lifetime.isCurrent() || !this.host?.rebuild) return;
        Promise.resolve(this.host.rebuild()).catch((err) => this.log(`hive: rebuild failed: ${err.message}`));
      },
      ...keepAwake,
    });
  }

  setting(key) {
    return this.host?.settings?.get?.(key) ?? this.settings?.get?.(key);
  }

  // Active work from live evidence only, so an unreconciled reservation or a
  // missing session never keeps the Mac awake: claims, open reviews and
  // launches whose session is running (not archived, exited or dormant), a
  // launch still starting within its admission window, helpers, and pending
  // CI waits.
  activeWork(now = Date.now()) {
    const running = (sid) => {
      const session = sid ? this.host?.sessions?.get?.(sid) : null;
      return Boolean(session && !session.archived && !session.dormant && session.status !== 'exited');
    };
    const ids = new Set();
    let ciWaits = 0;
    try {
      const graph = this.snapshots.graph;
      const doc = this.metadata.read();
      for (const id of hiveWorkIds(this, graph)) {
        const bead = graph.beads[id];
        if (bead.status === 'in_progress' && bead.assignee && running(bead.ownerSessionId)) ids.add(id);
      }
      for (const review of Object.values(doc.reviews || {})) {
        if (OPEN_REVIEW_STATES.has(review.state) && running(review.reviewerSessionId)) ids.add(review.workBeadId);
      }
      for (const launch of Object.values(doc.workerLaunches || {})) {
        if (!LIVE_LAUNCH_STATES.has(launch.state)) continue;
        if (launch.sessionId ? running(launch.sessionId) : now - (launch.createdAt || 0) < LAUNCH_WINDOW_MS) ids.add(launch.beadId);
      }
      for (const id of helperSlots(this, graph, now).keys()) ids.add(id);
      ciWaits = Object.values(doc.ciWaits || {}).filter((w) => w?.state === 'pending').length;
    } catch (err) {
      this.log(`hive: could not count active work: ${err.message}`);
    }
    return { active: ids.size > 0 || ciWaits > 0, work: ids.size, ciWaits };
  }

  evaluateKeepAwake() {
    if (!this.host || !this.metadata.lifetime.isCurrent()) {
      this.keepAwake.stop();
      return this.keepAwake.status;
    }
    return this.keepAwake.evaluate({ ...keepAwakeSettings((key) => this.setting(key)), ...this.activeWork() });
  }

  configuredPath() {
    const host = this.host;
    const raw = host?.settings?.get?.(BD_PATH_SETTING) ?? this.settings?.get?.(BD_PATH_SETTING);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  // On start, once the store has been checked, Hive settles what it can of
  // any writes left unfinished last time.
  attach(host) {
    this.metadata.lifetime.attach(this, host);
    this.watchdog = createWatchdog({ runtime: this, host });
    this.prLabels = createPrLabelSweep({ runtime: this, host });
    this.stopCiObservations = startCiWaits(this, host);
    this.attachmentRecovery = cleanupOrphanAttachments(this);
    try {
      threadAllCells(this);
    } catch (err) {
      this.log(`hive: could not give old messages topics: ${err.message}`);
    }
    try { reconcileRequests(this, host, { startup: true }); } catch (err) { this.log(`hive: requests unavailable: ${err.message}`); }
    this.stopRequestSubjects = startRequestSubjects(this, host);
    this.keepAwakeTimer = setInterval(() => this.evaluateKeepAwake(), KEEP_AWAKE_TICK_MS);
    this.keepAwakeTimer.unref?.();
    this.evaluateKeepAwake();
    this.recheck()
      .then(() => (this.metadata.lifetime.isCurrent(host) ? recover(this, host) : null))
      .then((recovered) => {
        if (recovered !== true || !this.metadata.lifetime.isCurrent(host)) return;
        this.pickup ||= createPickupDispatcher({ runtime: this, host });
        this.pickup.schedule();
      })
      .catch((err) => this.log(`hive: initial check failed: ${err.message}`));
  }

  async recover() {
    if (this.metadata.available) {
      reconcileRequests(this, this.host);
      for (const r of Object.values(this.metadata.read().requests || {})) {
        await notifyQueen(this, this.host, r.id);
        await notifyResolution(this, this.host, r.id);
      }
      await reconcileRequestSubjects(this, this.host);
    }
    const recovered = await recover(this, this.host);
    if (recovered !== true || !this.metadata.lifetime.isCurrent()) return;
    this.pickup ||= createPickupDispatcher({ runtime: this, host: this.host });
    return this.pickup.run();
  }

  afterWrite(beadIds) {
    afterWrite(this, beadIds);
    this.pickup?.schedule();
  }

  detach() {
    this.pickup?.stop();
    this.metadata.lifetime.stop();
    this.prLabels?.stop();
    this.stopCiObservations?.();
    this.stopRequestSubjects?.();
    this.watchdog?.stop();
    clearInterval(this.keepAwakeTimer);
    this.keepAwakeTimer = null;
    this.keepAwake.dispose();
    this.host = null;
  }

  changed() {
    if (!this.metadata.lifetime.isCurrent()) return;
    this.evaluateKeepAwake();
    this.watchdog?.schedule();
    const host = this.host;
    if (!host?.rebuild) return;
    Promise.resolve(host.rebuild()).catch((err) => this.log(`hive: rebuild failed: ${err.message}`));
  }

  // Gives new workstream regions their stored colour slot whenever the
  // bead graph changes. A failure only means fallback colours this time.
  reconcileColours() {
    try {
      reconcileColours(this.metadata, this.snapshots.current?.graph?.beads || {});
    } catch (err) {
      this.log(`hive: could not store workstream colours: ${err.message}`);
    }
  }

  backendChanged(next, { fromRefresh = false } = {}) {
    const wasReady = this._backendReady;
    this._backendReady = next.state === 'ready';
    this.changed();
    if (wasReady && !this._backendReady && !fromRefresh) this.snapshots?.invalidate();
  }

  async recheck() {
    this.metadata.lifetime.assertCurrent();
    await this.beads.probe();
    this.metadata.lifetime.assertCurrent();
    return this.snapshots.refresh();
  }

  async initializeStore() {
    this.metadata.lifetime.assertCurrent();
    const out = await this.beads.initialize();
    this.metadata.lifetime.assertCurrent();
    await this.snapshots.refresh();
    return out;
  }

  migrateRegions() {
    if (this.snapshots.hierarchyCurrent) migrateRegions(this.metadata, this.snapshots.graph.beads);
  }

  projection() {
    this.watchdog?.schedule();
    reconcileInactiveBindings(this, this.host);
    if (this.host && this.metadata.available) reconcileRequests(this, this.host);
    this.migrateRegions();
    const snap = this.snapshots.current;
    const key = `${snap.revision}:${this.metadata.version}:${this.beads.status.checkedAt}:${this.beads.status.state}:${trackingKey(this)}:${workLimit(this)}:${[...helperSlots(this).keys()].join(',')}`;
    if (this._projection.key !== key) {
      this._projection = { key, value: projectForGraph({ runtime: this, snapshot: snap }) };
    }
    return this._projection.value;
  }
}
