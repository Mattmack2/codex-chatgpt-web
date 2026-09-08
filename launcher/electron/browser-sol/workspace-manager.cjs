const { readWakeSource } = require("./workspace-source.cjs");

const DEFAULT_POLL_INTERVAL_MS = 2_000;

function isoNow(now) {
  return new Date(now()).toISOString();
}

function deliveryStatus(value) {
  if (value === true) return "delivered";
  if (typeof value === "string") return value;
  return value?.status || null;
}

function emptySource(sourcePath, message = "Waiting for Any-Clerk automatic wake state") {
  return {
    status: "unavailable",
    sourcePath,
    message,
    projectKey: null,
    providerCount: 0,
    queuedProviderCount: 0,
    unfinished: 0,
    activeInvocationIds: [],
    waveId: null,
    settlementId: null,
    settledAt: null,
    settlementRecorded: false,
  };
}

class BrowserSolWorkspaceManager {
  constructor({
    store,
    sourcePath,
    taskFactory,
    logger,
    onChange,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    readSource = readWakeSource,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!store || typeof store.read !== "function") throw new Error("Browser Sol workspace store is required");
    if (typeof taskFactory !== "function") throw new Error("Browser Sol task factory is required");
    this.store = store;
    this.sourcePath = sourcePath;
    this.taskFactory = taskFactory;
    this.logger = logger;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.readSource = readSource;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.tasks = new Map();
    this.sources = new Map();
    this.timer = null;
    this.stopped = false;
    this.ticking = null;
    this.deliveryInFlight = false;
    this.lastError = null;
  }

  workspaceList() {
    return this.store.read().workspaces || [];
  }

  taskFor(workspace) {
    let task = this.tasks.get(workspace.projectKey);
    if (!task) {
      task = this.taskFactory({
        workspace,
        updateWorkspace: (projectKey, patch) => this.updateWorkspace(projectKey, patch),
        onStateChange: () => this.publish(),
      });
      this.tasks.set(workspace.projectKey, task);
    } else {
      task.setWorkspace?.(workspace);
    }
    return task;
  }

  updateWorkspace(projectKey, patch) {
    const next = this.store.patch(projectKey, patch);
    this.taskFor(next)?.setWorkspace?.(next);
    return next;
  }

  sourceFor(projectKey) {
    return this.sources.get(projectKey) || emptySource(this.sourcePath);
  }

  snapshot() {
    const registry = this.store.read();
    const workspaces = registry.workspaces.map(workspace => {
      const task = this.tasks.get(workspace.projectKey);
      const source = this.sourceFor(workspace.projectKey);
      const taskSnapshot = task?.snapshot?.() || {
        status: workspace.threadId ? "unknown" : "unavailable",
        threadReady: Boolean(workspace.threadId),
        lastError: null,
        lastActivityAt: workspace.lastActivityAt,
        lastWakeAt: workspace.lastWakeAt,
      };
      return {
        projectKey: workspace.projectKey,
        displayName: workspace.displayName,
        cwd: workspace.cwd,
        automationEnabled: workspace.automationEnabled,
        pending: Boolean(workspace.pendingSettlementId),
        threadReady: taskSnapshot.threadReady === true || Boolean(workspace.threadId),
        taskStatus: taskSnapshot.status,
        sourceStatus: source.status,
        lastWakeAt: workspace.lastWakeAt,
        lastError: taskSnapshot.lastError || null,
      };
    });
    return {
      status: this.stopped ? "stopped" : "running",
      sourcePath: this.sourcePath,
      selectedProjectKey: registry.selectedProjectKey,
      workspaces,
      activeProjectKey: this.deliveryInFlight ? this.deliveryInFlight : null,
      lastError: this.lastError,
    };
  }

  publish() {
    this.onChange?.(this.snapshot());
  }

  async start() {
    this.stopped = false;
    await this.tick();
    if (this.timer === null && this.pollIntervalMs > 0) {
      this.timer = this.setIntervalImpl(() => { void this.tick(); }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    return this.snapshot();
  }

  stop() {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.stopped = true;
    for (const task of this.tasks.values()) task.close?.();
    this.publish();
  }

  close() {
    this.stop();
  }

  select(projectKey) {
    const registry = this.store.select(projectKey);
    this.publish();
    return registry;
  }

  addWorkspace(input) {
    const workspace = this.store.upsert(input);
    this.taskFor(workspace);
    this.publish();
    return workspace;
  }

  async open(projectKey = this.store.read().selectedProjectKey) {
    const workspace = this.store.get(projectKey);
    if (!workspace) throw new Error(`Unknown Browser Sol project: ${projectKey}`);
    const task = this.taskFor(workspace);
    const result = await task.openOrResume({ allowCreate: true });
    this.publish();
    return result;
  }

  async setAutomation(projectKey, enabled) {
    const workspace = this.store.get(projectKey);
    if (!workspace) throw new Error(`Unknown Browser Sol project: ${projectKey}`);
    const source = this.readOne(projectKey);
    const patch = { automationEnabled: enabled === true };
    if (enabled === true && !workspace.pendingSettlementId && source.status === "ready") {
      // Enabling observes the current durable boundary as the baseline.  A
      // settlement that happens after this call has a new Any-Clerk identity.
      patch.baselineSettlementId = source.settlementId;
      patch.lastDeliveredSettlementId = workspace.lastDeliveredSettlementId;
    }
    const next = this.store.patch(projectKey, patch);
    this.taskFor(next)?.setWorkspace?.(next);
    this.publish();
    await this.tick();
    return this.snapshot();
  }

  async explicitTestWake(projectKey = this.store.read().selectedProjectKey) {
    const workspace = this.store.get(projectKey);
    if (!workspace) throw new Error(`Unknown Browser Sol project: ${projectKey}`);
    await this.refreshTasks();
    if (this.busyProjectExists()) {
      return { status: "busy", message: "Another native Codex conversation is active" };
    }
    const task = this.taskFor(workspace);
    const result = await task.sendWake({ reason: "explicit-test" });
    this.publish();
    return result;
  }

  readOne(projectKey) {
    try {
      const source = this.readSource(this.sourcePath, projectKey);
      this.sources.set(projectKey, source);
      return source;
    } catch (error) {
      const source = emptySource(this.sourcePath, "Any-Clerk automatic wake state is unavailable");
      source.errorCode = error?.code || "source-read-failed";
      this.sources.set(projectKey, source);
      return source;
    }
  }

  async refreshSources() {
    for (const workspace of this.workspaceList()) this.readOne(workspace.projectKey);
  }

  async refreshTasks() {
    await Promise.all(this.workspaceList().map(async workspace => {
      const task = this.taskFor(workspace);
      await task.refreshActivity?.();
    }));
  }

  busyProjectExists() {
    return [...this.tasks.values()].some(task => ["busy", "starting", "unknown"].includes(task.snapshot?.().status));
  }

  observeSettlements() {
    let changed = false;
    for (const workspace of this.workspaceList()) {
      const source = this.sourceFor(workspace.projectKey);
      if (!workspace.automationEnabled || source.status !== "ready" || !source.settlementId) continue;
      const newSettlement = source.settlementId !== workspace.baselineSettlementId
        && source.settlementId !== workspace.lastDeliveredSettlementId
        && source.settlementId !== workspace.pendingSettlementId;
      if (!newSettlement) continue;
      const next = this.store.patch(workspace.projectKey, {
        pendingSettlementId: source.settlementId,
        pendingSince: isoNow(this.now),
      });
      this.taskFor(next)?.setWorkspace?.(next);
      this.logger?.info?.("browser_sol.settlement_pending", {
        projectKey: workspace.projectKey,
        settlementId: source.settlementId,
      });
      changed = true;
    }
    return changed;
  }

  pendingWorkspaces() {
    return this.workspaceList()
      .filter(workspace => workspace.automationEnabled && workspace.pendingSettlementId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.pendingSince || "") || 0;
        const rightTime = Date.parse(right.pendingSince || "") || 0;
        return leftTime - rightTime || left.projectKey.localeCompare(right.projectKey);
      });
  }

  async deliverNextPending() {
    if (this.deliveryInFlight || this.pendingWorkspaces().length === 0) return;
    // A manually started native Codex turn has priority over every automatic
    // wake, regardless of which project owns it.
    if (this.busyProjectExists()) return;
    const workspace = this.pendingWorkspaces()[0];
    const task = this.taskFor(workspace);
    this.deliveryInFlight = workspace.projectKey;
    this.publish();
    try {
      const result = await task.sendWake({ reason: "automatic-settlement" });
      const status = deliveryStatus(result);
      if (status === "delivered") {
        const current = this.store.get(workspace.projectKey);
        if (current?.pendingSettlementId === workspace.pendingSettlementId) {
          const next = this.store.patch(workspace.projectKey, {
            lastDeliveredSettlementId: workspace.pendingSettlementId,
            pendingSettlementId: null,
            pendingSince: null,
          });
          task.setWorkspace?.(next);
        }
        this.lastError = null;
        this.logger?.info?.("browser_sol.settlement_delivered", {
          projectKey: workspace.projectKey,
          settlementId: workspace.pendingSettlementId,
        });
      } else if (status !== "busy") {
        this.lastError = result?.message || "Browser Sol automatic wake is unavailable";
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.("browser_sol.settlement_delivery_failed", {
        projectKey: workspace.projectKey,
        errorCode: error?.code || "delivery-failed",
      });
    } finally {
      this.deliveryInFlight = false;
      this.publish();
    }
  }

  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      await this.refreshSources();
      this.observeSettlements();
      await this.refreshTasks();
      await this.deliverNextPending();
      this.publish();
      return this.snapshot();
    })();
    try {
      return await this.ticking;
    } finally {
      this.ticking = null;
    }
  }
}

module.exports = {
  BrowserSolWorkspaceManager,
  DEFAULT_POLL_INTERVAL_MS,
  emptySource,
};
