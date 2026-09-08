const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SOURCE_SCHEMA } = require("../electron/browser-sol/wake-source.cjs");
const {
  BrowserSolNativeTask,
  BROWSER_SOL_LABEL,
  BROWSER_SOL_PROMPT,
  resolveBrowserSolModel,
  readTaskIdentity,
  resolveCodexExecutable,
} = require("../electron/browser-sol/native-task.cjs");
const { BrowserSolWakeController } = require("../electron/browser-sol/wake-controller.cjs");
const { emptyWakeLedger } = require("../electron/browser-sol/wake-ledger.cjs");

const PROJECT_KEY = "project:github.com/mattmack2/evo-devo-lab";

function fixtureDocument({
  providerCount = 0,
  queuedProviderCount = 0,
  previousProviderCount = 0,
  previousQueuedProviderCount = 0,
  waveId = null,
  settlementId = null,
  settledAt = null,
} = {}) {
  return {
    schema_version: SOURCE_SCHEMA,
    projects: {
      [PROJECT_KEY]: {
        provider_count: providerCount,
        queued_count: queuedProviderCount,
        previous_provider_count: previousProviderCount,
        previous_queued_count: previousQueuedProviderCount,
        wave_id: waveId,
        settlement_id: settlementId,
        settled_at: settledAt,
      },
    },
    settlements: settlementId ? {
      [settlementId]: {
        project_key: PROJECT_KEY,
        wave_id: waveId,
        settlement_id: settlementId,
        provider_count_after: 0,
        provider_count_before: previousProviderCount,
        created_at: settledAt,
        published: false,
      },
    } : {},
    wakes: [],
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-sol-test-"));
  const sourcePath = path.join(root, "automatic-review-wakes.json");
  const ledgerPath = path.join(root, "wake-ledger.json");
  let current = fixtureDocument();
  fs.writeFileSync(sourcePath, `${JSON.stringify(current)}\n`);
  return {
    root,
    sourcePath,
    ledgerPath,
    setSource(next) {
      current = next;
      fs.writeFileSync(sourcePath, `${JSON.stringify(current)}\n`);
    },
    controller(delivery, options = {}) {
      return new BrowserSolWakeController({
        sourcePath,
        projectKey: PROJECT_KEY,
        ledgerPath,
        deliverWake: delivery,
        pollIntervalMs: 0,
        ...options,
      });
    },
  };
}

async function withFixture(callback) {
  const value = fixture();
  try { return await callback(value); }
  finally { fs.rmSync(value.root, { recursive: true, force: true }); }
}

test("fresh wake controller has the off state and never wakes on idle startup", async () => {
  await withFixture(async ({ controller }) => {
    const deliveries = [];
    const wake = controller(delivery => { deliveries.push(delivery); return { status: "delivered" }; });
    await wake.start();
    await wake.arm();
    await wake.tick();
    assert.equal(deliveries.length, 0);
    assert.equal(wake.snapshot().autoWake, "armed");
    assert.equal(wake.snapshot().unfinished, 0);
  });
});

test("a provider wave is observed from zero to unfinished without delivering early", async () => {
  await withFixture(async ({ controller, setSource }) => {
    const deliveries = [];
    const wake = controller(delivery => { deliveries.push(delivery); return { status: "delivered" }; });
    await wake.arm();
    setSource(fixtureDocument({ providerCount: 1, waveId: "wave:one" }));
    await wake.tick();
    assert.equal(deliveries.length, 0);
    assert.equal(wake.snapshot().lastSeenWaveId, "wave:one");
    assert.equal(wake.snapshot().unfinished, 1);
  });
});

test("one settlement produces exactly one delivered wake", async () => {
  await withFixture(async ({ controller, setSource }) => {
    const deliveries = [];
    const wake = controller(delivery => { deliveries.push(delivery); return { status: "delivered" }; });
    await wake.arm();
    setSource(fixtureDocument({ providerCount: 1, waveId: "wave:one" }));
    await wake.tick();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    await wake.tick();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].settlementId, "settlement:one");
    assert.equal(wake.snapshot().pending, false);
    assert.equal(wake.snapshot().lastDeliveredSettlementId, "settlement:one");
  });
});

test("rewriting the same source file does not duplicate a settlement", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let deliveries = 0;
    const wake = controller(() => { deliveries += 1; return { status: "delivered" }; });
    await wake.arm();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    assert.equal(deliveries, 1);
  });
});

test("a later wave and settlement can deliver once after an earlier settlement", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let deliveries = 0;
    const wake = controller(() => { deliveries += 1; return { status: "delivered" }; });
    await wake.arm();
    setSource(fixtureDocument({ providerCount: 1, waveId: "wave:one" }));
    await wake.tick();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    setSource(fixtureDocument({ providerCount: 1, waveId: "wave:two" }));
    await wake.tick();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:two", settlementId: "settlement:two" }));
    await wake.tick();
    assert.equal(deliveries, 2);
    assert.equal(wake.snapshot().lastSeenWaveId, "wave:two");
  });
});

test("disarm suppresses a settlement and removes pending delivery", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let deliveries = 0;
    const wake = controller(() => { deliveries += 1; return { status: "delivered" }; });
    await wake.arm();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.disarm();
    await wake.tick();
    assert.equal(deliveries, 0);
    assert.equal(wake.snapshot().autoWake, "off");
    assert.equal(wake.snapshot().pending, false);
  });
});

test("arming on an already settled source establishes a no-replay baseline", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let deliveries = 0;
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:old", settlementId: "settlement:old" }));
    const wake = controller(() => { deliveries += 1; return { status: "delivered" }; });
    await wake.arm();
    await wake.tick();
    assert.equal(deliveries, 0);
    assert.equal(wake.snapshot().baselineSettlementId, "settlement:old");
  });
});

test("an armed ledger recovers a settlement that appeared while the launcher was closed", async () => {
  await withFixture(async ({ controller, setSource, ledgerPath }) => {
    const first = controller(() => ({ status: "deferred" }));
    await first.arm();
    setSource(fixtureDocument({ providerCount: 1, waveId: "wave:one" }));
    await first.tick();
    first.stop();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    let deliveries = 0;
    const second = controller(() => { deliveries += 1; return { status: "delivered" }; });
    await second.tick();
    assert.equal(deliveries, 1);
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).lastDeliveredSettlementId, "settlement:one");
  });
});

test("a restarted controller does not replay its settled baseline", async () => {
  await withFixture(async ({ controller, setSource }) => {
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    let firstDeliveries = 0;
    const first = controller(() => { firstDeliveries += 1; return { status: "delivered" }; });
    await first.arm();
    assert.equal(firstDeliveries, 0);
    let secondDeliveries = 0;
    const second = controller(() => { secondDeliveries += 1; return { status: "delivered" }; });
    await second.start();
    assert.equal(secondDeliveries, 0);
  });
});

test("queued providers count as unfinished work", async () => {
  await withFixture(async ({ controller, setSource }) => {
    const wake = controller(() => ({ status: "delivered" }));
    await wake.arm();
    setSource(fixtureDocument({ queuedProviderCount: 2, waveId: "wave:queued" }));
    const snapshot = await wake.tick();
    assert.equal(snapshot.unfinished, 2);
    assert.equal(snapshot.providerQueuedCount, 2);
  });
});

test("busy task delivery leaves the settlement pending for a later tick", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let busy = true;
    let deliveries = 0;
    const wake = controller(() => {
      deliveries += 1;
      return busy ? { status: "busy", message: "task is busy" } : { status: "delivered" };
    });
    await wake.arm();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    assert.equal(deliveries, 1);
    assert.equal(wake.snapshot().pending, true);
    busy = false;
    await wake.tick();
    assert.equal(deliveries, 2);
    assert.equal(wake.snapshot().pending, false);
  });
});

test("a compaction or handoff defer is persisted instead of retried as a new wake", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let calls = 0;
    const wake = controller(() => {
      calls += 1;
      return { status: "deferred", message: "durable task is compacting" };
    });
    await wake.arm();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    await wake.tick();
    await wake.tick();
    assert.equal(calls, 2);
    assert.equal(wake.snapshot().pendingSettlementId, "settlement:one");
    assert.match(wake.snapshot().lastError, /compacting/);
  });
});

test("concurrent ticks share one in-flight delivery", async () => {
  await withFixture(async ({ controller, setSource }) => {
    let release;
    let calls = 0;
    const delivery = new Promise(resolve => { release = resolve; });
    const wake = controller(() => { calls += 1; return delivery; });
    await wake.arm();
    setSource(fixtureDocument({ previousProviderCount: 1, waveId: "wave:one", settlementId: "settlement:one" }));
    const first = wake.tick();
    const second = wake.tick();
    await Promise.resolve();
    assert.equal(calls, 1);
    release({ status: "delivered" });
    await Promise.all([first, second]);
    assert.equal(wake.snapshot().pending, false);
  });
});

test("unavailable source is surfaced without inventing a settlement", async () => {
  await withFixture(async ({ controller }) => {
    const wake = controller(() => ({ status: "delivered" }));
    wake.readSource = () => ({ status: "unavailable", message: "source missing" });
    const snapshot = await wake.tick();
    assert.equal(snapshot.sourceStatus, "unavailable");
    assert.equal(snapshot.pending, false);
  });
});

test("explicit Test Wake uses the delivery seam without changing settlement dedupe", async () => {
  await withFixture(async ({ controller }) => {
    const reasons = [];
    const wake = controller(input => { reasons.push(input.reason); return { status: "delivered" }; });
    const result = await wake.explicitTestWake();
    assert.equal(result.status, "delivered");
    assert.deepEqual(reasons, ["explicit-test"]);
    assert.equal(wake.snapshot().lastDeliveredSettlementId, null);
  });
});

test("the small ledger starts with only the durable wake fields", () => {
  const ledger = emptyWakeLedger();
  assert.deepEqual(Object.keys(ledger), [
    "version",
    "project",
    "armed",
    "armedAt",
    "baselineSettlementId",
    "lastSeenWaveId",
    "lastDeliveredSettlementId",
    "pendingSettlementId",
    "pendingSince",
    "lastWakeAt",
  ]);
  assert.equal(ledger.project, "evodevo");
});

function fakeNativeClient({ rows = [], modelRows: catalogRows = null, createdThreadId = "11111111-1111-4111-8111-111111111111", resumeError = null, readTurns = null } = {}) {
  const requests = [];
  const client = {
    requests,
    async initialize() {},
    async request(method, params) {
      requests.push({ method, params });
      if (method === "model/list") return {
        data: catalogRows || [{
          slug: "chatgpt-web/high",
          display_name: `${BROWSER_SOL_LABEL} — High`,
          supported_reasoning_levels: [{ effort: "high" }],
        }],
      };
      if (method === "thread/list") return { data: rows };
      if (method === "thread/start") return { thread: { id: createdThreadId, name: "Browser Sol", cwd: "/home/tester/Projects/evo-devo-lab" } };
      if (method === "thread/name/set") return { thread: { id: params.threadId, name: params.name } };
      if (method === "thread/resume") {
        if (resumeError) throw resumeError;
        return { thread: { id: params.threadId, name: "Browser Sol" } };
      }
      if (method === "thread/read") return {
        thread: {
          id: params.threadId,
          name: "Browser Sol",
          ...(Array.isArray(readTurns) ? { turns: readTurns } : {}),
        },
      };
      if (method === "turn/start") return { turn: { id: "22222222-2222-4222-8222-222222222222" } };
      throw new Error(`unexpected fake method ${method}`);
    },
    close() {},
  };
  return client;
}

test("Open/Resume creates one durable native task and opens its verified deep link", async () => {
  await withFixture(async ({ root }) => {
    const identityPath = path.join(root, "browser-sol-task.json");
    const opened = [];
    const client = fakeNativeClient();
    const task = new BrowserSolNativeTask({
      identityPath,
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async url => opened.push(url),
    });
    const snapshot = await task.openOrResume();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.threadId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(opened, ["codex://threads/11111111-1111-4111-8111-111111111111"]);
    assert.equal(JSON.parse(fs.readFileSync(identityPath, "utf8")).version, 1);
    assert.equal(client.requests.filter(request => request.method === "thread/start").length, 1);
  });
});

test("Open/Resume discovers only the exact Browser Sol task for EvoDevo", async () => {
  await withFixture(async ({ root }) => {
    const cwd = "/home/tester/Projects/evo-devo-lab";
    const exactThreadId = "66666666-6666-4666-8666-666666666666";
    const client = fakeNativeClient({ rows: [
      { id: "77777777-7777-4777-8777-777777777777", name: "Build Browser Sol desktop workflow", cwd },
      { id: "88888888-8888-4888-8888-888888888888", name: "Browser Sol", cwd: "/home/tester/Documents/any-clerk" },
      { id: exactThreadId, name: null, threadSource: "browser-sol", cwd },
    ] });
    const task = new BrowserSolNativeTask({
      identityPath: path.join(root, "browser-sol-task.json"),
      codexHome: path.join(root, "codex"),
      cwd,
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async () => {},
    });
    const snapshot = await task.openOrResume();
    assert.equal(snapshot.threadId, exactThreadId);
    assert.equal(client.requests.filter(request => request.method === "thread/start").length, 0);
  });
});

test("Open/Resume reuses the saved task identity instead of creating another outer task", async () => {
  await withFixture(async ({ root }) => {
    const identityPath = path.join(root, "browser-sol-task.json");
    fs.writeFileSync(identityPath, JSON.stringify({
      version: 1,
      threadId: "33333333-3333-4333-8333-333333333333",
      title: "Browser Sol",
      cwd: "/home/tester/Projects/evo-devo-lab",
    }));
    const client = fakeNativeClient();
    const task = new BrowserSolNativeTask({
      identityPath,
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async () => {},
    });
    await task.openOrResume();
    assert.equal(client.requests.filter(request => request.method === "thread/start").length, 0);
    assert.equal(client.requests.filter(request => request.method === "thread/resume").length, 1);
  });
});

test("Open/Resume recreates a readable empty task whose native rollout is gone", async () => {
  await withFixture(async ({ root }) => {
    const threadId = "99999999-9999-4999-8999-999999999999";
    const resumeError = new Error(`no rollout found for thread id ${threadId}`);
    resumeError.code = -32600;
    const client = fakeNativeClient({ resumeError, readTurns: [] });
    fs.writeFileSync(path.join(root, "browser-sol-task.json"), JSON.stringify({
      version: 1,
      threadId,
      title: "Browser Sol",
      cwd: "/home/tester/Projects/evo-devo-lab",
    }));
    const task = new BrowserSolNativeTask({
      identityPath: path.join(root, "browser-sol-task.json"),
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async () => {},
    });
    const snapshot = await task.openOrResume();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.threadId, "11111111-1111-4111-8111-111111111111");
    assert.equal(client.requests.filter(request => request.method === "thread/start").length, 1);
    assert.equal(client.requests.filter(request => request.method === "thread/read").length, 1);
  });
});

test("automatic delivery sends the compact wake to the same durable task at semantic high effort", async () => {
  await withFixture(async ({ root }) => {
    const identityPath = path.join(root, "browser-sol-task.json");
    fs.writeFileSync(identityPath, JSON.stringify({
      version: 1,
      threadId: "44444444-4444-4444-8444-444444444444",
      title: "Browser Sol",
      cwd: "/home/tester/Projects/evo-devo-lab",
    }));
    const client = fakeNativeClient();
    const task = new BrowserSolNativeTask({
      identityPath,
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async () => {},
    });
    const result = await task.sendWake();
    const request = client.requests.find(entry => entry.method === "turn/start");
    assert.equal(result.status, "delivered");
    assert.equal(request.params.threadId, "44444444-4444-4444-8444-444444444444");
    assert.equal(request.params.model, "chatgpt-web/high");
    assert.equal(request.params.effort, "high");
    assert.equal(request.params.input[0].text, BROWSER_SOL_PROMPT);
  });
});

test("automatic delivery does not create a new task when no durable task is attachable", async () => {
  await withFixture(async ({ root }) => {
    const client = fakeNativeClient({ rows: [] });
    const task = new BrowserSolNativeTask({
      identityPath: path.join(root, "browser-sol-task.json"),
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      openExternal: async () => {},
    });
    const result = await task.sendWake();
    assert.equal(result.status, "unavailable");
    assert.equal(client.requests.some(entry => entry.method === "thread/start"), false);
  });
});

test("native task reports context checkpointing and durable rollover time", async () => {
  await withFixture(async ({ root }) => {
    const identityPath = path.join(root, "browser-sol-task.json");
    const threadId = "55555555-5555-4555-8555-555555555555";
    fs.writeFileSync(identityPath, JSON.stringify({
      version: 1,
      threadId,
      title: "Browser Sol",
      cwd: "/home/tester/Projects/evo-devo-lab",
    }));
    const client = fakeNativeClient();
    const task = new BrowserSolNativeTask({
      identityPath,
      codexHome: path.join(root, "codex"),
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
      clientFactory: () => client,
      now: () => Date.parse("2026-09-08T05:00:00.000Z"),
    });
    await task.openOrResume();
    task.identity.threadId = threadId;
    task.handleNotification({ method: "item/started", params: { threadId, item: { type: "contextCompaction" } } });
    assert.equal(task.snapshot().contextStatus, "checkpointing");
    task.handleNotification({
      method: "item/completed",
      params: { threadId, item: { type: "contextCompaction", completedAtMs: Date.parse("2026-09-08T05:01:02.000Z") } },
    });
    assert.equal(task.snapshot().contextStatus, "rolled-over");
    assert.equal(task.snapshot().lastRolloverAt, "2026-09-08T05:01:02.000Z");
    assert.equal(JSON.parse(fs.readFileSync(identityPath, "utf8")).lastRolloverAt, "2026-09-08T05:01:02.000Z");
  });
});

test("native task refreshes a stale native-only model cache before creating Browser Sol", async () => {
  await withFixture(async ({ root }) => {
    const identityPath = path.join(root, "browser-sol-task.json");
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "models_cache.json"), "stale native catalog\n");
    const nativeRows = [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      supported_reasoning_levels: [{ effort: "high" }],
    }];
    const webRows = [{
      slug: "chatgpt-web/high",
      display_name: `${BROWSER_SOL_LABEL} — High`,
      supported_reasoning_levels: [{ effort: "high" }],
    }];
    let factoryCalls = 0;
    const task = new BrowserSolNativeTask({
      identityPath,
      codexHome,
      cwd: "/home/tester/Projects/evo-devo-lab",
      executable: "/usr/local/bin/codex",
        clientFactory: () => {
          const modelRows = factoryCalls++ === 0 ? nativeRows : webRows;
          return fakeNativeClient({ modelRows });
        },
      openExternal: async () => {},
    });
    const snapshot = await task.openOrResume();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.model, "chatgpt-web/high");
    assert.equal(factoryCalls, 2);
    assert.equal(
      fs.readdirSync(codexHome).some(name => name.startsWith("models_cache.json.browser-sol-refresh-")),
      false,
    );
  });
});

test("semantic high effort fails closed when the ChatGPT Web route is absent", () => {
  assert.equal(resolveBrowserSolModel({ data: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", supported_reasoning_levels: [{ effort: "high" }] },
  ] }), null);
});

test("task identity rejects malformed or non-absolute metadata without touching history", async () => {
  await withFixture(async ({ root }) => {
    const filePath = path.join(root, "browser-sol-task.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, threadId: "not-a-thread", cwd: "relative" }));
    assert.deepEqual(readTaskIdentity(filePath), {
      threadId: null,
      title: null,
      cwd: null,
      updatedAt: null,
      contextStatus: "normal",
      lastRolloverAt: null,
    });
  });
});

test("Codex executable resolution prefers an explicit configured executable", () => {
  assert.equal(resolveCodexExecutable({
    env: { BROWSER_SOL_CODEX_EXECUTABLE: "/opt/codex-custom", PATH: "" },
    existsSync: value => value === "/opt/codex-custom",
  }), "/opt/codex-custom");
});
