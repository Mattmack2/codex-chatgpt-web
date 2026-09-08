const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("../atomic-file.cjs");

const TASK_FILE_VERSION = 1;
const BROWSER_SOL_EFFORT = "high";
const BROWSER_SOL_LABEL = "ChatGPT Web";
const CONTEXT_STATUSES = new Set(["normal", "checkpointing", "rolled-over"]);
const BROWSER_SOL_PROMPT = [
  "AUTOMATIC EVODEVO WAKE",
  "current wave settled active=0 queued=0",
  "refresh current durable Git/Operator/Any-Clerk state, inspect returned/pushed provider work, adjudicate and continue; don't rerun paid work from lifecycle metadata, protect BLIND/T0/Trial001.",
].join("\n");
const EXTERNAL_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextStatus(value) {
  return CONTEXT_STATUSES.has(value) ? value : "normal";
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeErrorMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "browser-sol-route-unavailable") return String(error.message);
  if (code === "thread_not_found" || /thread not found|no rollout found/i.test(String(error?.message || ""))) {
    return "The saved Browser Sol task is no longer available";
  }
  return "Native Codex task control is unavailable; open Codex once and try again";
}

function readTaskIdentity(filePath, { readFileSync = fs.readFileSync } = {}) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || value.version !== TASK_FILE_VERSION) return {};
    return {
      threadId: EXTERNAL_THREAD_ID.test(value.threadId || "") ? value.threadId : null,
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : null,
      cwd: typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? value.cwd : null,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
      contextStatus: contextStatus(value.contextStatus),
      lastRolloverAt: validTimestamp(value.lastRolloverAt),
    };
  } catch {
    return {};
  }
}

function writeTaskIdentity(filePath, identity, { write = writePrivateFileAtomic } = {}) {
  write(filePath, `${JSON.stringify({
    version: TASK_FILE_VERSION,
    threadId: identity.threadId || null,
    title: identity.title || null,
    cwd: identity.cwd || null,
    updatedAt: identity.updatedAt || new Date().toISOString(),
    contextStatus: contextStatus(identity.contextStatus),
    lastRolloverAt: validTimestamp(identity.lastRolloverAt),
  }, null, 2)}\n`);
}

function resolveCodexExecutable({ env = process.env, existsSync = fs.existsSync } = {}) {
  const configured = [env.BROWSER_SOL_CODEX_EXECUTABLE, env.CODEX_CLI_PATH, env.CODEX_EXECUTABLE]
    .find(value => typeof value === "string" && value.trim());
  const candidates = [
    configured,
    process.platform === "linux" ? "/usr/lib/chatgpt/resources/codex" : null,
    process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null,
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    "codex",
  ].filter(Boolean);
  return candidates.find(candidate => !path.isAbsolute(candidate) || existsSync(candidate)) || null;
}

function modelRows(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

function modelIdentifier(row) {
  return [row?.slug, row?.id, row?.model]
    .find(value => typeof value === "string" && value.trim())?.trim() || null;
}

function modelLabel(row) {
  return [row?.display_name, row?.displayName, row?.name, row?.description]
    .find(value => typeof value === "string" && value.trim())?.trim() || "";
}

function modelSupportsEffort(row, effort) {
  const levels = row?.supported_reasoning_levels ?? row?.supportedReasoningEfforts;
  if (!Array.isArray(levels)) return false;
  return levels.some(level => (typeof level === "string" ? level : level?.effort || level?.reasoningEffort) === effort);
}

function resolveBrowserSolModel(result, effort = BROWSER_SOL_EFFORT) {
  const candidates = modelRows(result)
    .map(row => ({ row, id: modelIdentifier(row), label: modelLabel(row) }))
    .filter(candidate => candidate.id && modelSupportsEffort(candidate.row, effort))
    .filter(candidate => new RegExp(BROWSER_SOL_LABEL.replace(" ", "\\s*"), "i").test(candidate.label)
      || /^chatgpt-web(?:\/|$)/i.test(candidate.id));
  const preferred = candidates.find(candidate => new RegExp(`(?:^|[^a-z])${effort}(?:$|[^a-z])`, "i").test(candidate.label)
    && !/extra\s+high|pro/i.test(candidate.label));
  return (preferred || candidates[0])?.id || null;
}

class AppServerClient {
  constructor({ executable, cwd, env = process.env, spawnImpl = spawn, requestTimeoutMs = 15_000, onNotification }) {
    this.executable = executable;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.initialized = false;
    this.child = spawnImpl(executable, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", chunk => this.consume(chunk));
    this.child.on("error", error => this.failAll(error));
    this.child.on("close", () => this.failAll(new Error("Codex app-server exited")));
  }

  consume(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) {
          const error = new Error(message.error.message || "Codex app-server request failed");
          error.code = message.error.code;
          waiting.reject(error);
        } else waiting.resolve(message.result);
      } else if (message?.method) this.onNotification?.(message);
    }
  }

  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        error.code = "request-timeout";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: { name: "codex-web-gpt-browser-sol", version: "1" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    this.initialized = true;
  }

  close() {
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("Codex app-server client closed"));
    }
    this.pending.clear();
    try { this.child.kill(); } catch {}
  }
}

class BrowserSolNativeTask {
  constructor({
    identityPath,
    codexHome,
    cwd,
    effort = BROWSER_SOL_EFFORT,
    openExternal = async () => {},
    logger,
    executable,
    clientFactory = options => new AppServerClient(options),
    now = () => Date.now(),
  }) {
    this.identityPath = identityPath;
    this.codexHome = codexHome;
    this.cwd = cwd || path.join(os.homedir(), "Projects", "evo-devo-lab");
    this.effort = effort;
    this.openExternal = openExternal;
    this.logger = logger;
    this.executable = executable || resolveCodexExecutable();
    this.clientFactory = clientFactory;
    this.now = now;
    const savedIdentity = readTaskIdentity(identityPath);
    const identityMatchesBrowserSolProject = savedIdentity.title === "Browser Sol"
      && savedIdentity.cwd === this.cwd;
    this.identity = identityMatchesBrowserSolProject
      ? savedIdentity
      : { ...savedIdentity, threadId: null, title: null, cwd: null };
    this.client = null;
    this.status = this.identity.threadId ? "idle" : "unavailable";
    this.lastError = null;
    this.activeTurnId = null;
    this.lastWakeAt = null;
    this.contextStatus = contextStatus(this.identity.contextStatus);
    this.lastRolloverAt = this.identity.lastRolloverAt || null;
    this.starting = null;
    this.resolvedModel = null;
  }

  snapshot() {
    return {
      status: this.status,
      connected: this.status === "idle" || this.status === "busy",
      threadId: this.identity.threadId,
      title: this.identity.title || "Browser Sol",
      model: this.resolvedModel || BROWSER_SOL_LABEL,
      effort: this.effort,
      context: "Native Codex durable task history with automatic compaction/handoff",
      contextStatus: this.contextStatus,
      lastRolloverAt: this.lastRolloverAt,
      lastWakeAt: this.lastWakeAt,
      lastError: this.lastError,
      activeTurnId: this.activeTurnId,
    };
  }

  notify() {
    this.onStateChange?.(this.snapshot());
  }

  setStateChangeListener(listener) {
    this.onStateChange = listener;
  }

  persistIdentity(thread) {
    const next = {
      ...this.identity,
      threadId: thread.id,
      title: thread.name || this.identity.title || "Browser Sol",
      cwd: thread.cwd || this.cwd,
      updatedAt: new Date(this.now()).toISOString(),
    };
    writeTaskIdentity(this.identityPath, next);
    this.identity = next;
  }

  setContextStatus(nextStatus, rolloverAt = null) {
    const nextContextStatus = contextStatus(nextStatus);
    const nextRolloverAt = nextContextStatus === "rolled-over"
      ? validTimestamp(rolloverAt) || this.lastRolloverAt || new Date(this.now()).toISOString()
      : this.lastRolloverAt;
    const changed = this.contextStatus !== nextContextStatus || this.lastRolloverAt !== nextRolloverAt;
    this.contextStatus = nextContextStatus;
    this.lastRolloverAt = nextRolloverAt;
    if (this.identity.threadId) {
      const next = {
        ...this.identity,
        contextStatus: this.contextStatus,
        lastRolloverAt: this.lastRolloverAt,
        updatedAt: new Date(this.now()).toISOString(),
      };
      try {
        writeTaskIdentity(this.identityPath, next);
        this.identity = next;
      } catch (error) {
        this.logger?.warn?.("browser_sol.context_state_persist_failed", { errorCode: error?.code || "write-failed" });
      }
    }
    if (changed) this.notify();
  }

  taskRows(result) {
    return Array.isArray(result?.data) ? result.data : [];
  }

  async findExistingTask(client) {
    const result = await client.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      useStateDbOnly: true,
    });
    return this.taskRows(result).find(thread => {
      if (!EXTERNAL_THREAD_ID.test(thread?.id || "")) return false;
      if (typeof thread.cwd === "string" && /(?:^|\/)any-clerk(?:\/|$)/i.test(thread.cwd)) return false;
      if (thread.cwd !== this.cwd) return false;
      return thread?.threadSource === "browser-sol" || thread?.name === "Browser Sol";
    }) || null;
  }

  async resolveModel(client) {
    const result = await client.request("model/list", {
      limit: 100,
      includeHidden: false,
    });
    let model = resolveBrowserSolModel(result, this.effort);
    if (!model) model = await this.refreshModelCatalog(client);
    if (!model) {
      const error = new Error(`ChatGPT Web effort ${this.effort} is unavailable in the native model catalog`);
      error.code = "browser-sol-route-unavailable";
      throw error;
    }
    this.resolvedModel = model;
    return model;
  }

  async refreshModelCatalog(client) {
    const cachePath = path.join(this.codexHome || "", "models_cache.json");
    if (!path.isAbsolute(cachePath)) return null;
    let backupPath = null;
    try {
      if (!fs.lstatSync(cachePath).isFile()) return null;
      backupPath = `${cachePath}.browser-sol-refresh-${process.pid}-${this.now()}`;
      fs.renameSync(cachePath, backupPath);
    } catch {
      return null;
    }

    let model = null;
    try {
      client.close();
      if (this.client === client) this.client = null;
      const refreshedClient = await this.ensureClient();
      const result = await refreshedClient.request("model/list", {
        limit: 100,
        includeHidden: false,
      });
      model = resolveBrowserSolModel(result, this.effort);
      if (model) {
        this.logger?.info?.("browser_sol.model_catalog_refreshed", { effort: this.effort });
      }
    } catch (error) {
      this.logger?.debug?.("browser_sol.model_catalog_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      if (model) fs.rmSync(backupPath, { force: true });
      else if (!fs.existsSync(cachePath)) fs.renameSync(backupPath, cachePath);
      else fs.rmSync(backupPath, { force: true });
    } catch (error) {
      this.logger?.warn?.("browser_sol.model_catalog_cache_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return model;
  }

  async ensureClient() {
    if (!this.executable) {
      this.status = "unavailable";
      this.lastError = "Codex executable is unavailable";
      this.notify();
      throw new Error(this.lastError);
    }
    if (!this.client) {
      this.client = this.clientFactory({
        executable: this.executable,
        cwd: this.cwd,
        env: { ...process.env, CODEX_HOME: this.codexHome },
        onNotification: message => this.handleNotification(message),
      });
      try {
        await this.client.initialize();
      } catch (error) {
        this.client.close();
        this.client = null;
        this.status = "unavailable";
        this.lastError = safeErrorMessage(error);
        this.notify();
        throw error;
      }
    }
    return this.client;
  }

  handleNotification(message) {
    const params = message?.params || {};
    const notificationThreadId = params.threadId
      || params.thread?.id
      || params.item?.threadId
      || params.turn?.threadId;
    if (notificationThreadId !== this.identity.threadId) return;
    const itemType = params.item?.type;
    const isContextCompaction = itemType === "contextCompaction"
      || itemType === "context_compaction"
      || itemType === "context-compaction";
    if (message.method === "item/started" && isContextCompaction) {
      this.setContextStatus("checkpointing");
    } else if (message.method === "item/completed" && isContextCompaction) {
      this.setContextStatus("rolled-over", this.notificationTimestamp(params));
    } else if (message.method === "thread/compacted") {
      this.setContextStatus("rolled-over", this.notificationTimestamp(params));
    }
    if (message.method === "turn/started") {
      if (this.contextStatus === "rolled-over") this.setContextStatus("normal");
      this.activeTurnId = params.turn?.id || this.activeTurnId;
      this.status = "busy";
      this.notify();
    } else if (message.method === "turn/completed") {
      if (!this.activeTurnId || params.turn?.id === this.activeTurnId) {
        this.activeTurnId = null;
        this.status = "idle";
        this.notify();
      }
    } else if (message.method === "thread/status/changed") {
      const threadStatus = typeof params.status === "string"
        ? params.status
        : params.status?.type || params.status?.status;
      if (threadStatus === "active") this.status = "busy";
      if (threadStatus === "idle") this.status = "idle";
      this.notify();
    }
  }

  notificationTimestamp(params) {
    const value = params.item?.completedAtMs
      ?? params.item?.completed_at_ms
      ?? params.completedAtMs
      ?? params.completed_at_ms
      ?? params.timestamp;
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
    return new Date(this.now()).toISOString();
  }

  async ensureTask({ allowCreate }) {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const client = await this.ensureClient();
      const model = this.resolvedModel || await this.resolveModel(client);
      const activeClient = this.client || client;
      let createdTask = false;
      const createTask = async () => {
        const result = await activeClient.request("thread/start", {
          cwd: this.cwd,
          model,
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          historyMode: "legacy",
          ephemeral: false,
          threadSource: "browser-sol",
          sessionStartSource: "startup",
        });
        const thread = result?.thread;
        if (!thread || !EXTERNAL_THREAD_ID.test(thread.id || "")) throw new Error("Codex did not return a durable Browser Sol task");
        this.persistIdentity(thread);
        await activeClient.request("thread/name/set", {
          threadId: thread.id,
          name: "Browser Sol",
        });
      };
      if (!this.identity.threadId) {
        const existing = await this.findExistingTask(activeClient);
        if (existing) this.persistIdentity(existing);
      }
      if (!this.identity.threadId && allowCreate) {
        await createTask();
        createdTask = true;
      }
      if (!this.identity.threadId) throw new Error("No durable Browser Sol task is connected");
      if (!createdTask) {
        try {
          await activeClient.request("thread/resume", {
            threadId: this.identity.threadId,
            cwd: this.identity.cwd || this.cwd,
            model,
            sandbox: "danger-full-access",
            excludeTurns: true,
          });
        } catch (error) {
          if (!/no rollout found for thread id/i.test(String(error?.message || ""))) {
            this.status = "unavailable";
            this.lastError = safeErrorMessage(error);
            this.notify();
            throw error;
          }
          try {
            const readable = await activeClient.request("thread/read", {
              threadId: this.identity.threadId,
              includeTurns: false,
            });
            const turns = readable?.thread?.turns;
            if (allowCreate && Array.isArray(turns) && turns.length === 0) {
              this.identity = {
                ...this.identity,
                threadId: null,
                title: null,
                cwd: null,
              };
              await createTask();
              createdTask = true;
              this.logger?.info?.("browser_sol.thread_recreated_without_rollout", {});
            } else {
              this.logger?.debug?.("browser_sol.thread_read_without_rollout", {});
            }
          } catch (readError) {
            this.status = "unavailable";
            this.lastError = safeErrorMessage(readError);
            this.notify();
            throw readError;
          }
        }
      }
      this.status = "idle";
      this.lastError = null;
      this.notify();
      return this.identity.threadId;
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async openOrResume() {
    try {
      const threadId = await this.ensureTask({ allowCreate: true });
      await this.openExternal(`codex://threads/${encodeURIComponent(threadId)}`);
      return this.snapshot();
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      this.status = "unavailable";
      this.notify();
      const friendly = new Error(this.lastError);
      friendly.code = error?.code;
      throw friendly;
    }
  }

  async sendWake({ reason = "automatic-settlement" } = {}) {
    if (this.status === "busy") return { status: "busy", message: "Browser Sol task is busy; automatic wake is pending" };
    try {
      const threadId = await this.ensureTask({ allowCreate: false });
      const client = await this.ensureClient();
      const model = this.resolvedModel || await this.resolveModel(client);
      const activeClient = this.client || client;
      const result = await activeClient.request("turn/start", {
        threadId,
        input: [{ type: "text", text: BROWSER_SOL_PROMPT }],
        model,
        effort: this.effort,
        turnTrigger: reason === "explicit-test" ? "browser-sol-explicit-test" : "browser-sol-auto-wake",
      });
      const turnId = result?.turn?.id;
      this.activeTurnId = typeof turnId === "string" ? turnId : null;
      this.status = "busy";
      this.lastWakeAt = new Date(this.now()).toISOString();
      this.lastError = null;
      this.notify();
      this.logger?.info?.("browser_sol.native_task_turn_started", {
        reason,
        hasTurnId: typeof turnId === "string",
      });
      return { status: "delivered", threadId, turnId: typeof turnId === "string" ? turnId : null };
    } catch (error) {
      const message = safeErrorMessage(error);
      this.status = "unavailable";
      this.lastError = message;
      this.notify();
      this.logger?.warn?.("browser_sol.native_task_turn_unavailable", { errorCode: error?.code || "task-control-failed" });
      this.logger?.debug?.("browser_sol.native_task_turn_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { status: "unavailable", message };
    }
  }

  close() {
    this.client?.close();
    this.client = null;
  }
}

module.exports = {
  AppServerClient,
  BROWSER_SOL_EFFORT,
  BROWSER_SOL_PROMPT,
  BROWSER_SOL_LABEL,
  BrowserSolNativeTask,
  EXTERNAL_THREAD_ID,
  readTaskIdentity,
  resolveBrowserSolModel,
  resolveCodexExecutable,
  safeErrorMessage,
  writeTaskIdentity,
};
