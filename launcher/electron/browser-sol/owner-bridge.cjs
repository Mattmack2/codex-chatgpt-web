const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL = "chatgpt-web/high";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_PROMPT = [
  "Start this Browser Sol project conversation.",
  "Read the repository's durable current state and governing AGENTS/docs first.",
  "Use the browser-only ChatGPT Web route for this conversation; do not substitute a local model.",
  "Then report the current unresolved hinge and wait for the owner.",
].join("\n");
const MAX_ROLLOUT_TAIL_BYTES = 256 * 1024;

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

function errorWithCode(message, code = "codex-owner-unavailable") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function jsonEventThreadId(value) {
  const candidates = [
    value?.thread_id,
    value?.threadId,
    value?.thread?.id,
    value?.payload?.thread_id,
    value?.payload?.threadId,
    value?.payload?.thread?.id,
  ];
  return candidates.find(candidate => typeof candidate === "string" && THREAD_ID.test(candidate)) || null;
}

function collectTail(filePath, { readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
  try {
    statSync(filePath);
  } catch {
    return "";
  }
  try {
    const raw = readFileSync(filePath);
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const start = Math.max(0, data.length - MAX_ROLLOUT_TAIL_BYTES);
    return data.subarray(start).toString("utf8");
  } catch {
    return "";
  }
}

function rolloutEventType(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "event_msg" && record.payload && typeof record.payload === "object") {
    return typeof record.payload.type === "string" ? record.payload.type : null;
  }
  return typeof record.type === "string" ? record.type : null;
}

function walkForRollout(directory, suffix, { readdirSync = fs.readdirSync } = {}) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
    }
  }
  return null;
}

function inspectNativeThread({ codexHome, threadId, readFileSync = fs.readFileSync, statSync = fs.statSync, readdirSync = fs.readdirSync } = {}) {
  if (!THREAD_ID.test(threadId || "")) return { status: "unknown", running: false, signature: null };
  const sessions = path.join(codexHome || os.homedir(), "sessions");
  const rolloutPath = walkForRollout(sessions, `-${threadId}.jsonl`, { readdirSync });
  if (!rolloutPath) return { status: "unknown", running: false, signature: null, rolloutPath: null };
  const text = collectTail(rolloutPath, { readFileSync, statSync });
  let started = 0;
  let completed = 0;
  let lastTurnId = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const event = rolloutEventType(record);
    if (event === "task_started") {
      started += 1;
      lastTurnId = record.payload?.turn_id || record.turn_id || lastTurnId;
    } else if (event === "task_complete" || event === "task_aborted" || event === "task_failed") {
      completed += 1;
    }
  }
  return {
    status: started > completed ? "busy" : "idle",
    running: started > completed,
    signature: `${started}:${completed}:${lastTurnId || ""}`,
    rolloutPath,
  };
}

function runCodexCommand({
  executable,
  args,
  cwd,
  codexHome,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  onStdoutLine,
  onStderrLine,
} = {}) {
  if (!executable) return Promise.reject(errorWithCode("Codex CLI executable is unavailable"));
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnImpl(executable, args, {
      cwd,
      env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (failure, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(errorWithCode(`Codex CLI command timed out: codex ${args[0]}`, "codex-owner-timeout"));
    }, timeoutMs);
    timer.unref?.();
    const read = (chunk, target, callback) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (target === "stdout") stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) callback?.(line);
    };
    child.stdout?.on("data", chunk => read(chunk, "stdout", onStdoutLine));
    child.stderr?.on("data", chunk => read(chunk, "stderr", onStderrLine));
    child.once("error", error => finish(errorWithCode(error.message, error.code || "codex-owner-spawn")));
    child.once("close", (code, signal) => {
      if (code === 0) finish(null, { stdout, stderr, code, signal });
      else finish(errorWithCode(
        stderr.trim() || `Codex CLI exited with status ${code ?? "unknown"}`,
        "codex-owner-command-failed",
      ));
    });
  });
}

class CodexOwnerBridge {
  constructor({
    executable,
    codexHome,
    cwd,
    model = DEFAULT_MODEL,
    spawnImpl = spawn,
    readFileSync = fs.readFileSync,
    statSync = fs.statSync,
    readdirSync = fs.readdirSync,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    logger,
  } = {}) {
    this.executable = executable || resolveCodexExecutable();
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.model = model;
    this.spawnImpl = spawnImpl;
    this.readFileSync = readFileSync;
    this.statSync = statSync;
    this.readdirSync = readdirSync;
    this.commandTimeoutMs = commandTimeoutMs;
    this.logger = logger;
  }

  inspectThread(threadId) {
    return inspectNativeThread({
      codexHome: this.codexHome,
      threadId,
      readFileSync: this.readFileSync,
      statSync: this.statSync,
      readdirSync: this.readdirSync,
    });
  }

  async queueMessage({ threadId, message, cwd = this.cwd, model = this.model } = {}) {
    if (!THREAD_ID.test(threadId || "")) throw errorWithCode("A valid Codex thread is required", "invalid-thread-id");
    if (typeof message !== "string" || !message.trim()) throw errorWithCode("A non-empty Codex message is required", "invalid-message");
    const args = [
      "queue",
      "--thread", threadId,
      "--message", message,
      "--model", model,
      "--cd", cwd,
    ];
    await runCodexCommand({
      executable: this.executable,
      args,
      cwd,
      codexHome: this.codexHome,
      spawnImpl: this.spawnImpl,
      timeoutMs: this.commandTimeoutMs,
      onStderrLine: line => this.logger?.debug?.("browser_sol.codex_queue_stderr", { line: line.slice(0, 500) }),
    });
    return { status: "queued", threadId, model };
  }

  async startConversation({ cwd = this.cwd, model = this.model, prompt = DEFAULT_INITIAL_PROMPT } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) throw errorWithCode("An initial Browser Sol prompt is required", "invalid-message");
    let threadId = null;
    const args = [
      "exec",
      "--json",
      "--model", model,
      "--sandbox", "read-only",
      "--ask-for-approval", "on-request",
      "--thread-source", "browser-sol",
      "--skip-git-repo-check",
      "--cd", cwd,
      prompt,
    ];
    await runCodexCommand({
      executable: this.executable,
      args,
      cwd,
      codexHome: this.codexHome,
      spawnImpl: this.spawnImpl,
      timeoutMs: Math.max(this.commandTimeoutMs, 5 * 60_000),
      onStdoutLine: line => {
        try {
          const event = JSON.parse(line);
          threadId ||= jsonEventThreadId(event);
        } catch {}
      },
    });
    if (!threadId) throw errorWithCode("Codex did not report the new Browser Sol conversation", "thread-id-missing");
    return { status: "created", threadId, model };
  }
}

module.exports = {
  DEFAULT_INITIAL_PROMPT,
  DEFAULT_MODEL,
  THREAD_ID,
  CodexOwnerBridge,
  collectTail,
  inspectNativeThread,
  jsonEventThreadId,
  resolveCodexExecutable,
  rolloutEventType,
  runCodexCommand,
};
