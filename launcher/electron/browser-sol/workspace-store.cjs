const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("../atomic-file.cjs");
const { THREAD_ID } = require("./owner-bridge.cjs");

const WORKSPACE_SCHEMA = "browser-sol-workspaces/v1";
const PROJECT_KEY = /^project:[^\s]{1,240}$/;
const MAX_DISPLAY_NAME = 96;
const MAX_CWD_LENGTH = 4096;

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function validateProjectKey(value) {
  if (typeof value !== "string" || !PROJECT_KEY.test(value.trim())) {
    throw new Error("Browser Sol project key must use the project:<identity> form");
  }
  return value.trim();
}

function validateCwd(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > MAX_CWD_LENGTH) {
    throw new Error("Browser Sol project directory must be an absolute path");
  }
  return path.normalize(value);
}

function normalizeWorkspace(value) {
  const projectKey = validateProjectKey(value?.projectKey);
  const displayName = typeof value?.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim().slice(0, MAX_DISPLAY_NAME)
    : projectKey.slice("project:".length);
  const cwd = validateCwd(value?.cwd);
  return {
    projectKey,
    displayName,
    cwd,
    threadId: THREAD_ID.test(value?.threadId || "") ? value.threadId : null,
    threadTitle: nullableString(value?.threadTitle),
    automationEnabled: value?.automationEnabled === true,
    baselineSettlementId: nullableString(value?.baselineSettlementId),
    lastDeliveredSettlementId: nullableString(value?.lastDeliveredSettlementId),
    pendingSettlementId: nullableString(value?.pendingSettlementId),
    pendingSince: validTimestamp(value?.pendingSince),
    lastActivityAt: validTimestamp(value?.lastActivityAt),
    lastWakeAt: validTimestamp(value?.lastWakeAt),
  };
}

function emptyWorkspaceRegistry() {
  return {
    schema: WORKSPACE_SCHEMA,
    selectedProjectKey: null,
    workspaces: [],
  };
}

function normalizeRegistry(value) {
  if (!value || typeof value !== "object" || value.schema !== WORKSPACE_SCHEMA || !Array.isArray(value.workspaces)) {
    return emptyWorkspaceRegistry();
  }
  const workspaces = [];
  const seen = new Set();
  for (const candidate of value.workspaces) {
    try {
      const workspace = normalizeWorkspace(candidate);
      if (seen.has(workspace.projectKey)) continue;
      seen.add(workspace.projectKey);
      workspaces.push(workspace);
    } catch {}
  }
  const selectedProjectKey = typeof value.selectedProjectKey === "string"
    && workspaces.some(workspace => workspace.projectKey === value.selectedProjectKey)
    ? value.selectedProjectKey
    : workspaces[0]?.projectKey || null;
  return { schema: WORKSPACE_SCHEMA, selectedProjectKey, workspaces };
}

function legacyWorkspace({ defaultWorkspace, legacyTaskPath, legacyLedgerPath, readFileSync = fs.readFileSync } = {}) {
  if (!defaultWorkspace || typeof defaultWorkspace !== "object") return null;
  let task = {};
  let ledger = {};
  try { task = JSON.parse(readFileSync(legacyTaskPath, "utf8")); } catch {}
  try { ledger = JSON.parse(readFileSync(legacyLedgerPath, "utf8")); } catch {}
  if (!THREAD_ID.test(task?.threadId || "") && ledger?.armed !== true) return null;
  try {
    return normalizeWorkspace({
      ...defaultWorkspace,
      threadId: task.threadId,
      threadTitle: task.title,
      automationEnabled: ledger.armed === true,
      baselineSettlementId: ledger.baselineSettlementId,
      lastDeliveredSettlementId: ledger.lastDeliveredSettlementId,
      pendingSettlementId: ledger.pendingSettlementId,
      pendingSince: ledger.pendingSince,
      lastWakeAt: ledger.lastWakeAt,
      lastActivityAt: task.updatedAt,
    });
  } catch {
    return null;
  }
}

function readWorkspaceRegistry(filePath, options = {}) {
  try {
    return normalizeRegistry(JSON.parse(options.readFileSync?.(filePath, "utf8") || fs.readFileSync(filePath, "utf8")));
  } catch {
    const migrated = legacyWorkspace(options);
    if (!migrated) return emptyWorkspaceRegistry();
    return {
      schema: WORKSPACE_SCHEMA,
      selectedProjectKey: migrated.projectKey,
      workspaces: [migrated],
    };
  }
}

function writeWorkspaceRegistry(filePath, registry, { write = writePrivateFileAtomic } = {}) {
  const normalized = normalizeRegistry(registry);
  write(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
}

class BrowserSolWorkspaceStore {
  constructor({ filePath, defaultWorkspace, legacyTaskPath, legacyLedgerPath, readFileSync = fs.readFileSync } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("Workspace registry path must be absolute");
    this.filePath = filePath;
    this.legacyOptions = { defaultWorkspace, legacyTaskPath, legacyLedgerPath, readFileSync };
    this.registry = readWorkspaceRegistry(filePath, this.legacyOptions);
    if (this.registry.workspaces.length === 0 && defaultWorkspace) {
      const workspace = normalizeWorkspace(defaultWorkspace);
      this.registry = {
        schema: WORKSPACE_SCHEMA,
        selectedProjectKey: workspace.projectKey,
        workspaces: [workspace],
      };
      this.persist();
    } else if (this.registry.workspaces.length > 0 && !this.registry.selectedProjectKey) {
      this.registry.selectedProjectKey = this.registry.workspaces[0].projectKey;
      this.persist();
    }
    this.maybePersistMigration();
  }

  maybePersistMigration() {
    try {
      if (!fs.existsSync(this.filePath)) this.persist();
    } catch {}
  }

  persist() {
    writeWorkspaceRegistry(this.filePath, this.registry);
  }

  read() {
    return structuredClone(this.registry);
  }

  get(projectKey) {
    return this.registry.workspaces.find(workspace => workspace.projectKey === projectKey) || null;
  }

  upsert(input) {
    const workspace = normalizeWorkspace(input);
    const index = this.registry.workspaces.findIndex(item => item.projectKey === workspace.projectKey);
    if (index < 0) this.registry.workspaces.push(workspace);
    else this.registry.workspaces[index] = { ...this.registry.workspaces[index], ...workspace };
    if (!this.registry.selectedProjectKey) this.registry.selectedProjectKey = workspace.projectKey;
    this.persist();
    return structuredClone(workspace);
  }

  patch(projectKey, patch) {
    const current = this.get(projectKey);
    if (!current) throw new Error(`Unknown Browser Sol project: ${projectKey}`);
    const next = normalizeWorkspace({ ...current, ...patch, projectKey: current.projectKey });
    const index = this.registry.workspaces.findIndex(item => item.projectKey === projectKey);
    this.registry.workspaces[index] = next;
    this.persist();
    return structuredClone(next);
  }

  select(projectKey) {
    if (!this.get(projectKey)) throw new Error(`Unknown Browser Sol project: ${projectKey}`);
    this.registry.selectedProjectKey = projectKey;
    this.persist();
    return this.read();
  }
}

module.exports = {
  MAX_CWD_LENGTH,
  MAX_DISPLAY_NAME,
  PROJECT_KEY,
  WORKSPACE_SCHEMA,
  BrowserSolWorkspaceStore,
  emptyWorkspaceRegistry,
  normalizeRegistry,
  normalizeWorkspace,
  readWorkspaceRegistry,
  validateCwd,
  validateProjectKey,
  writeWorkspaceRegistry,
};
