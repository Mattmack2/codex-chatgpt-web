const { DEFAULT_MODEL, DEFAULT_INITIAL_PROMPT } = require("./owner-bridge.cjs");

const DEFAULT_MODEL_EFFORT = "high";
const DEFAULT_QUEUE_GRACE_MS = 60_000;

function isoNow(now) {
  return new Date(now()).toISOString();
}

function safeErrorMessage(error) {
  if (error?.code === "invalid-thread-id") return "The saved Browser Sol conversation is invalid";
  if (error?.code === "thread-id-missing") return "Codex did not report the new Browser Sol conversation";
  if (/thread not found|no rollout found/i.test(String(error?.message || ""))) {
    return "The saved Browser Sol conversation is no longer available";
  }
  return error instanceof Error ? error.message : String(error);
}

class BrowserSolNativeTask {
  constructor({
    workspace,
    ownerBridge,
    updateWorkspace,
    logger,
    onStateChange,
    now = () => Date.now(),
    queueGraceMs = DEFAULT_QUEUE_GRACE_MS,
  } = {}) {
    if (!workspace || typeof workspace !== "object") throw new Error("Browser Sol workspace is required");
    if (!ownerBridge || typeof ownerBridge.inspectThread !== "function") {
      throw new Error("Browser Sol owner bridge is required");
    }
    this.workspace = { ...workspace };
    this.ownerBridge = ownerBridge;
    this.updateWorkspace = updateWorkspace;
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.now = now;
    this.queueGraceMs = queueGraceMs;
    this.status = this.workspace.threadId ? "unknown" : "unavailable";
    this.lastError = null;
    this.lastObserved = null;
    this.lastObservedSignature = null;
    this.lastQueuedAt = null;
    this.lastQueuedSignature = null;
    this.opening = null;
    this.queueing = null;
    this.closed = false;
  }

  get projectKey() {
    return this.workspace.projectKey;
  }

  get threadId() {
    return this.workspace.threadId;
  }

  setStateChangeListener(listener) {
    this.onStateChange = listener;
  }

  setWorkspace(workspace) {
    if (!workspace || workspace.projectKey !== this.workspace.projectKey) {
      throw new Error("Browser Sol workspace identity cannot change");
    }
    const previousThreadId = this.workspace.threadId;
    this.workspace = { ...this.workspace, ...workspace };
    if (previousThreadId !== this.workspace.threadId) {
      this.lastObserved = null;
      this.lastObservedSignature = null;
      this.lastQueuedAt = null;
      this.lastQueuedSignature = null;
      this.status = this.workspace.threadId ? "unknown" : "unavailable";
    }
    this.notify();
  }

  snapshot() {
    return {
      projectKey: this.workspace.projectKey,
      displayName: this.workspace.displayName,
      cwd: this.workspace.cwd,
      status: this.status,
      connected: ["idle", "busy"].includes(this.status),
      threadReady: Boolean(this.workspace.threadId),
      threadTitle: this.workspace.threadTitle || this.workspace.displayName,
      model: DEFAULT_MODEL,
      effort: DEFAULT_MODEL_EFFORT,
      lastError: this.lastError,
      lastActivityAt: this.workspace.lastActivityAt,
      lastWakeAt: this.workspace.lastWakeAt,
      observedAt: this.lastObserved?.observedAt || null,
      observedRolloutPath: this.lastObserved?.rolloutPath || null,
      activitySignature: this.lastObservedSignature,
    };
  }

  notify() {
    this.onStateChange?.(this.snapshot());
  }

  patchWorkspace(patch) {
    const next = this.updateWorkspace?.(this.projectKey, patch);
    this.workspace = {
      ...this.workspace,
      ...(next && typeof next === "object" ? next : patch),
    };
  }

  async refreshActivity() {
    if (this.closed) return this.snapshot();
    if (!this.workspace.threadId) {
      this.status = "unavailable";
      this.lastObserved = null;
      this.lastObservedSignature = null;
      this.notify();
      return this.snapshot();
    }
    let observed;
    try {
      observed = this.ownerBridge.inspectThread(this.workspace.threadId);
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      this.status = "unknown";
      this.notify();
      return this.snapshot();
    }
    this.lastObserved = { ...observed, observedAt: isoNow(this.now) };
    const signatureChanged = observed.signature && observed.signature !== this.lastQueuedSignature;
    this.lastObservedSignature = observed.signature || null;
    if (observed.status === "busy") {
      this.status = "busy";
    } else if (observed.status === "idle") {
      const queuedFor = this.lastQueuedAt === null ? Infinity : this.now() - this.lastQueuedAt;
      if (this.lastQueuedAt !== null && !signatureChanged && queuedFor < this.queueGraceMs) {
        // `codex queue` returns before the normal Codex owner records task_started.
        // Keep the global scheduler conservative during that hand-off window.
        this.status = "busy";
      } else if (this.lastQueuedAt !== null && !signatureChanged && queuedFor >= this.queueGraceMs) {
        this.status = "unknown";
        this.lastError = "Waiting for the native Codex owner to acknowledge the queued turn";
      } else {
        this.status = "idle";
        this.lastQueuedAt = null;
        this.lastQueuedSignature = null;
        this.lastError = null;
      }
    } else {
      this.status = this.lastQueuedAt === null ? "unknown" : "busy";
    }
    this.notify();
    return this.snapshot();
  }

  async openOrResume({ allowCreate = true } = {}) {
    if (this.closed) throw new Error("Browser Sol task is closed");
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (this.workspace.threadId) {
        await this.refreshActivity();
        return this.snapshot();
      }
      if (!allowCreate) return this.snapshot();
      this.status = "starting";
      this.lastError = null;
      this.notify();
      try {
        const result = await this.ownerBridge.startConversation({
          cwd: this.workspace.cwd,
          model: DEFAULT_MODEL,
          prompt: DEFAULT_INITIAL_PROMPT,
        });
        const now = isoNow(this.now);
        this.patchWorkspace({
          threadId: result.threadId,
          threadTitle: this.workspace.displayName,
          lastActivityAt: now,
        });
        this.status = "idle";
        this.lastError = null;
        this.logger?.info?.("browser_sol.conversation_created", { projectKey: this.projectKey });
        this.notify();
        return this.snapshot();
      } catch (error) {
        this.status = "error";
        this.lastError = safeErrorMessage(error);
        this.logger?.warn?.("browser_sol.conversation_create_failed", {
          projectKey: this.projectKey,
          errorCode: error?.code || "create-failed",
        });
        this.notify();
        throw error;
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async sendWake({ reason = "automatic-settlement" } = {}) {
    if (this.closed) return { status: "unavailable", message: "Browser Sol task is closed" };
    if (this.queueing) return { status: "busy", message: "A Browser Sol wake is already being queued" };
    await this.refreshActivity();
    if (!this.workspace.threadId) return { status: "unavailable", message: "Start the Browser Sol conversation first" };
    if (["busy", "starting", "unknown"].includes(this.status)) {
      return { status: "busy", message: "The native Codex conversation is busy or not yet observable" };
    }
    this.queueing = (async () => {
      const signatureBefore = this.lastObservedSignature;
      try {
        const result = await this.ownerBridge.queueMessage({
          threadId: this.workspace.threadId,
          cwd: this.workspace.cwd,
          model: DEFAULT_MODEL,
          message: [
            "Continue this project conversation.",
            "Refresh the repository, durable operator state, and Any-Clerk state first.",
            "Review returned work and continue from the current unresolved hinge; preserve the project’s governing safety and evidence rules.",
          ].join("\n"),
        });
        const now = isoNow(this.now);
        this.lastQueuedAt = this.now();
        this.lastQueuedSignature = signatureBefore;
        this.status = "busy";
        this.lastError = null;
        this.patchWorkspace({ lastWakeAt: now, lastActivityAt: now });
        this.logger?.info?.("browser_sol.wake_queued", { projectKey: this.projectKey, reason });
        this.notify();
        return { status: "delivered", threadReady: true, ...result };
      } catch (error) {
        this.lastError = safeErrorMessage(error);
        this.status = "error";
        this.logger?.warn?.("browser_sol.wake_queue_failed", {
          projectKey: this.projectKey,
          reason,
          errorCode: error?.code || "queue-failed",
        });
        this.notify();
        return { status: "unavailable", message: this.lastError };
      } finally {
        this.queueing = null;
      }
    })();
    return this.queueing;
  }

  close() {
    this.closed = true;
    this.opening = null;
    this.queueing = null;
    // There is deliberately no child process here.  The desktop Codex owner
    // owns the app-server and the conversation lifecycle.
  }
}

module.exports = {
  BrowserSolNativeTask,
  DEFAULT_QUEUE_GRACE_MS,
  DEFAULT_MODEL_EFFORT,
  safeErrorMessage,
};
