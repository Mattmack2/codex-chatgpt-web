const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CodexOwnerBridge,
  inspectNativeThread,
} = require("../electron/browser-sol/owner-bridge.cjs");
const { BrowserSolWorkspaceManager } = require("../electron/browser-sol/workspace-manager.cjs");
const { BrowserSolWorkspaceStore } = require("../electron/browser-sol/workspace-store.cjs");
const { readWakeSource } = require("../electron/browser-sol/workspace-source.cjs");

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "browser-sol-test-"));
}

function sourceRecord(projectKey, settlementId, { providerCount = 0, queuedCount = 0 } = {}) {
  return {
    status: "ready",
    sourcePath: "/tmp/automatic-review-wakes.json",
    projectKey,
    providerCount,
    queuedProviderCount: queuedCount,
    unfinished: providerCount + queuedCount,
    activeInvocationIds: [],
    waveId: settlementId,
    settlementId,
    settledAt: "2026-09-08T00:00:00.000Z",
    settlementRecorded: Boolean(settlementId && providerCount === 0 && queuedCount === 0),
  };
}

function fakeChild(stdoutLines = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { destroyed: false, write() {} };
  child.kill = () => {};
  queueMicrotask(() => {
    for (const line of stdoutLines) child.stdout.emit("data", `${line}\n`);
    child.emit("close", 0, null);
  });
  return child;
}

test("Any-Clerk settlement authority is accepted only for the current zero-work record", () => {
  const directory = tempDirectory();
  const sourcePath = path.join(directory, "wakes.json");
  const projectKey = "project:github.com/example/project";
  const document = {
    schema_version: "any-clerk-automatic-review-wakes/v1",
    projects: {
      [projectKey]: {
        provider_count: 0,
        queued_count: 0,
        previous_provider_count: 1,
        previous_queued_count: 0,
        wave_id: "wave:one",
        settlement_id: "wave:one",
        settled_at: "2026-09-08T00:00:00.000Z",
      },
    },
    settlements: {
      "wave:one": {
        project_key: projectKey,
        wave_id: "wave:one",
        settlement_id: "wave:one",
        provider_count_after: 0,
        queued_count_after: 0,
        created_at: "2026-09-08T00:00:00.000Z",
      },
    },
  };
  fs.writeFileSync(sourcePath, JSON.stringify(document));
  const settled = readWakeSource(sourcePath, projectKey);
  assert.equal(settled.settlementId, "wave:one");
  assert.equal(settled.unfinished, 0);

  document.projects[projectKey].provider_count = 1;
  fs.writeFileSync(sourcePath, JSON.stringify(document));
  const active = readWakeSource(sourcePath, projectKey);
  assert.equal(active.settlementId, null);
  assert.equal(active.unfinished, 1);
});

test("workspace registry persists identity and automation metadata without provider history", () => {
  const directory = tempDirectory();
  const store = new BrowserSolWorkspaceStore({
    filePath: path.join(directory, "workspaces.json"),
    defaultWorkspace: {
      projectKey: "project:github.com/example/project",
      displayName: "Example",
      cwd: directory,
    },
  });
  store.patch("project:github.com/example/project", {
    threadId: "12345678-1234-1234-1234-123456789abc",
    automationEnabled: true,
    pendingSettlementId: "wave:one",
    pendingSince: "2026-09-08T00:00:00.000Z",
  });
  const reloaded = new BrowserSolWorkspaceStore({ filePath: path.join(directory, "workspaces.json") });
  const workspace = reloaded.get("project:github.com/example/project");
  assert.equal(workspace.threadId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(workspace.automationEnabled, true);
  assert.equal(workspace.pendingSettlementId, "wave:one");
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "workspaces.json"), "utf8"));
  assert.equal("providerCount" in persisted, false);
  assert.equal("messages" in persisted, false);
  assert.equal("history" in persisted, false);
});

test("owner bridge queues through the installed Codex CLI without spawning an app-server", async () => {
  const calls = [];
  const bridge = new CodexOwnerBridge({
    executable: "/usr/bin/codex",
    codexHome: "/tmp/codex-home",
    spawnImpl: (executable, args) => {
      calls.push({ executable, args });
      return fakeChild();
    },
  });
  const result = await bridge.queueMessage({
    threadId: "12345678-1234-1234-1234-123456789abc",
    cwd: "/tmp/project",
    message: "Continue.",
  });
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "queue");
  assert.equal(calls[0].args.includes("app-server"), false);
  assert.deepEqual(calls[0].args.slice(-2), ["--cd", "/tmp/project"]);
});

test("owner bridge records a newly created native thread from codex exec JSON", async () => {
  const calls = [];
  const bridge = new CodexOwnerBridge({
    executable: "/usr/bin/codex",
    spawnImpl: (executable, args) => {
      calls.push({ executable, args });
      return fakeChild([JSON.stringify({ thread_id: "12345678-1234-1234-1234-123456789abc" })]);
    },
  });
  const result = await bridge.startConversation({ cwd: "/tmp/project", prompt: "Start." });
  assert.equal(result.threadId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(calls[0].args[0], "exec");
  assert.equal(calls[0].args.includes("app-server"), false);
  assert.equal(calls[0].args.includes("--sandbox"), true);
});

test("native owner activity is observed from rollout metadata without duplicating conversation history", () => {
  const directory = tempDirectory();
  const threadId = "12345678-1234-1234-1234-123456789abc";
  const sessions = path.join(directory, "sessions", "2026", "09", "08");
  fs.mkdirSync(sessions, { recursive: true });
  const rolloutPath = path.join(sessions, `rollout-2026-09-08-${threadId}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n"));
  const observed = inspectNativeThread({ codexHome: directory, threadId });
  assert.equal(observed.status, "idle");
  assert.equal(observed.running, false);
  assert.match(observed.signature, /^1:1:/);
});

test("workspace manager delivers a settlement exactly once and serializes manual priority", async () => {
  const directory = tempDirectory();
  const store = new BrowserSolWorkspaceStore({
    filePath: path.join(directory, "workspaces.json"),
    defaultWorkspace: {
      projectKey: "project:github.com/example/one",
      displayName: "One",
      cwd: directory,
      automationEnabled: true,
    },
  });
  store.upsert({
    projectKey: "project:github.com/example/two",
    displayName: "Two",
    cwd: directory,
    automationEnabled: true,
  });
  const sources = new Map([
    ["project:github.com/example/one", sourceRecord("project:github.com/example/one", "wave:one")],
    ["project:github.com/example/two", sourceRecord("project:github.com/example/two", "wave:two")],
  ]);
  const statuses = new Map([
    ["project:github.com/example/one", "idle"],
    ["project:github.com/example/two", "busy"],
  ]);
  const deliveries = [];
  const manager = new BrowserSolWorkspaceManager({
    store,
    sourcePath: "/tmp/source.json",
    pollIntervalMs: 0,
    readSource: (_path, projectKey) => sources.get(projectKey),
    taskFactory: ({ workspace }) => ({
      snapshot: () => ({ status: statuses.get(workspace.projectKey), threadReady: true, lastError: null }),
      setWorkspace() {},
      async refreshActivity() {},
      async sendWake() {
        deliveries.push(workspace.projectKey);
        return { status: "delivered" };
      },
      close() {},
    }),
  });

  await manager.start();
  assert.deepEqual(deliveries, []);
  statuses.set("project:github.com/example/two", "idle");
  await manager.tick();
  await manager.tick();
  assert.deepEqual(deliveries, ["project:github.com/example/one", "project:github.com/example/two"]);
  assert.equal(store.get("project:github.com/example/one").pendingSettlementId, null);
  assert.equal(store.get("project:github.com/example/two").pendingSettlementId, null);
  manager.stop();
});

