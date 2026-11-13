import { createPickupDispatcher } from './pickup.js';
import { createWatchdog } from './watchdog.js';
import { workLimit } from './admission.js';
import { reconcileRequests, notifyQueen, notifyResolution } from './requests.js';
import { trackingKey } from './tracking.js';
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

export const BD_PATH_SETTING = 'bdPath';

// Everything Hive keeps for the life of the process, built by the store
// factory before any host façade exists. `attach(host)` happens on activate.
export class HiveRuntime {
  constructor({ settings = null, log = () => {}, env = process.env } = {}) {
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
        this.changed();
        if (this.host) reopenUnfinished(this);
      },
      log,
    });
    this.pendingParticipants = new Map();
    this._projection = { key: '', value: null };
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
    this.attachmentRecovery = cleanupOrphanAttachments(this);
    try {
      threadAllCells(this);
    } catch (err) {
      this.log(`hive: could not give old messages topics: ${err.message}`);
    }
    try { reconcileRequests(this, host, { startup: true }); } catch (err) { this.log(`hive: requests unavailable: ${err.message}`); }
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
    this.watchdog?.stop();
    this.host = null;
  }

  changed() {
    if (!this.metadata.lifetime.isCurrent()) return;
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
    if (this.host && this.metadata.available) reconcileRequests(this, this.host);
    this.migrateRegions();
    const snap = this.snapshots.current;
    const key = `${snap.revision}:${this.metadata.version}:${this.beads.status.checkedAt}:${this.beads.status.state}:${trackingKey(this)}:${workLimit(this)}`;
    if (this._projection.key !== key) {
      this._projection = { key, value: projectForGraph({ runtime: this, snapshot: snap }) };
    }
    return this._projection.value;
  }
}
