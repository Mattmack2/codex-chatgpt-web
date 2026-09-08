const { readWakeSource } = require("./wake-source.cjs");
const { readWakeLedger, writeWakeLedger } = require("./wake-ledger.cjs");

const DEFAULT_POLL_INTERVAL_MS = 2_000;

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function deliveryStatus(value) {
  if (value === true) return "delivered";
  if (typeof value === "string") return value;
  return value?.status;
}

class BrowserSolWakeController {
  constructor({
    sourcePath,
    projectKey,
    ledgerPath,
    deliverWake,
    getTaskSnapshot = () => ({ status: "unavailable", threadId: null }),
    logger,
    onChange,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    readSource = readWakeSource,
    readLedger = readWakeLedger,
    writeLedger = writeWakeLedger,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    if (typeof deliverWake !== "function") throw new Error("Browser Sol wake delivery is required");
    this.sourcePath = sourcePath;
    this.projectKey = projectKey;
    this.ledgerPath = ledgerPath;
    this.deliverWake = deliverWake;
    this.getTaskSnapshot = getTaskSnapshot;
    this.logger = logger;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.readSource = readSource;
    this.readLedger = readLedger;
    this.writeLedger = writeLedger;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.ledger = this.readLedger(this.ledgerPath);
    this.source = null;
    this.timer = null;
    this.deliveryInFlight = false;
    this.lastError = null;
  }

  snapshot() {
    const source = this.source || {
      status: "unavailable",
      providerCount: 0,
      queuedProviderCount: 0,
      unfinished: 0,
      previousUnfinished: 0,
      waveId: null,
      settlementId: null,
      settledAt: null,
      message: "Waiting for Any-Clerk automatic wake state",
    };
    return {
      project: "evodevo",
      projectKey: this.projectKey,
      sourceStatus: source.status,
      sourceMessage: source.message || null,
      providerActiveCount: source.providerCount || 0,
      providerQueuedCount: source.queuedProviderCount || 0,
      unfinished: source.unfinished || 0,
      previousUnfinished: source.previousUnfinished || 0,
      wave: source.waveId,
      settlement: source.settlementId,
      settledAt: source.settledAt,
      autoWake: this.ledger.armed ? "armed" : "off",
      armed: this.ledger.armed,
      baselineSettlementId: this.ledger.baselineSettlementId,
      lastSeenWaveId: this.ledger.lastSeenWaveId,
      lastDeliveredSettlementId: this.ledger.lastDeliveredSettlementId,
      pendingSettlementId: this.ledger.pendingSettlementId,
      pending: this.ledger.pendingSettlementId !== null,
      lastWakeAt: this.ledger.lastWakeAt,
      deliveryInFlight: this.deliveryInFlight,
      lastError: this.lastError,
      task: this.getTaskSnapshot(),
    };
  }

  publish() {
    this.onChange?.(this.snapshot());
  }

  persist() {
    this.writeLedger(this.ledgerPath, this.ledger);
  }

  async start() {
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
  }

  async arm() {
    const source = this.readSource(this.sourcePath, this.projectKey);
    this.source = source;
    this.ledger = {
      ...this.ledger,
      armed: true,
      armedAt: isoNow(this.now()),
      baselineSettlementId: source.status === "ready" ? source.settlementId : this.ledger.baselineSettlementId,
      // An active wave at arm time is live work, not historical replay. Remember it so its
      // eventual settlement can be delivered even if the launcher is restarted in between.
      lastSeenWaveId: source.status === "ready" ? source.waveId : this.ledger.lastSeenWaveId,
      pendingSettlementId: null,
      pendingSince: null,
    };
    this.lastError = null;
    this.persist();
    this.publish();
    return this.snapshot();
  }

  async disarm() {
    this.ledger = {
      ...this.ledger,
      armed: false,
      armedAt: null,
      baselineSettlementId: null,
      pendingSettlementId: null,
      pendingSince: null,
    };
    this.lastError = null;
    this.persist();
    this.publish();
    return this.snapshot();
  }

  async tick() {
    let source;
    try {
      source = this.readSource(this.sourcePath, this.projectKey);
    } catch (error) {
      source = { status: "unavailable", message: "Any-Clerk automatic wake state is unavailable" };
      this.lastError = "Any-Clerk automatic wake state is unavailable";
      this.logger?.debug?.("browser_sol.wake_source_read_failed", { errorCode: error?.code || "read-failed" });
    }
    this.source = source;
    if (source.status !== "ready") {
      this.publish();
      return this.snapshot();
    }

    let ledgerChanged = false;
    if (this.ledger.armed && source.unfinished > 0 && source.waveId
      && source.waveId !== this.ledger.lastSeenWaveId) {
      this.ledger = { ...this.ledger, lastSeenWaveId: source.waveId };
      ledgerChanged = true;
    }

    const settlementIsNew = source.settlementId
      && source.settlementId !== this.ledger.baselineSettlementId
      && source.settlementId !== this.ledger.lastDeliveredSettlementId
      && source.settlementId !== this.ledger.pendingSettlementId;
    const isSettlementTransition = source.unfinished === 0 && source.previousUnfinished > 0;
    const hasDurableSettlement = Boolean(source.settlementId && source.waveId);
    if (this.ledger.armed && isSettlementTransition && settlementIsNew && hasDurableSettlement) {
      this.ledger = {
        ...this.ledger,
        pendingSettlementId: source.settlementId,
        pendingSince: isoNow(this.now()),
      };
      ledgerChanged = true;
      this.logger?.info?.("browser_sol.wake_settlement_observed", { waveId: source.waveId });
    }
    if (ledgerChanged) this.persist();
    await this.tryDeliverPending();
    this.publish();
    return this.snapshot();
  }

  async tryDeliverPending() {
    const settlementId = this.ledger.pendingSettlementId;
    if (!this.ledger.armed || !settlementId || this.deliveryInFlight) return;
    this.deliveryInFlight = true;
    this.publish();
    try {
      const result = await this.deliverWake({
        settlementId,
        waveId: this.source?.waveId || this.ledger.lastSeenWaveId,
        settledAt: this.source?.settledAt || null,
        reason: "automatic-settlement",
      });
      const status = deliveryStatus(result);
      if (status === "delivered") {
        this.ledger = {
          ...this.ledger,
          lastDeliveredSettlementId: settlementId,
          lastWakeAt: isoNow(this.now()),
          pendingSettlementId: null,
          pendingSince: null,
        };
        this.lastError = null;
        this.persist();
        this.logger?.info?.("browser_sol.wake_delivered", { waveId: this.source?.waveId || null });
      } else if (status === "deferred" || status === "busy" || status === "unavailable") {
        this.lastError = result?.message || (status === "busy"
          ? "Browser Sol task is busy; automatic wake is pending"
          : status === "unavailable" ? "Browser Sol task is unavailable; automatic wake is pending" : null);
        this.logger?.debug?.("browser_sol.wake_delivery_deferred", { status });
      } else {
        this.lastError = "Browser Sol wake delivery returned an unknown status";
        this.logger?.warn?.("browser_sol.wake_delivery_unknown_status", { status: status || null });
      }
    } catch (error) {
      this.lastError = "Browser Sol task is unavailable; automatic wake is pending";
      this.logger?.warn?.("browser_sol.wake_delivery_failed", { errorCode: error?.code || "delivery-failed" });
    } finally {
      this.deliveryInFlight = false;
      this.publish();
    }
  }

  async explicitTestWake() {
    const result = await this.deliverWake({
      settlementId: null,
      waveId: null,
      settledAt: null,
      reason: "explicit-test",
    });
    this.publish();
    return result;
  }
}

module.exports = {
  BrowserSolWakeController,
  DEFAULT_POLL_INTERVAL_MS,
};
