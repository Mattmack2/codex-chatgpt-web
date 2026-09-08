const fs = require("node:fs");
const { writePrivateFileAtomic } = require("../atomic-file.cjs");

const LEDGER_VERSION = 1;

function emptyWakeLedger() {
  return {
    version: LEDGER_VERSION,
    project: "evodevo",
    armed: false,
    armedAt: null,
    baselineSettlementId: null,
    lastSeenWaveId: null,
    lastDeliveredSettlementId: null,
    pendingSettlementId: null,
    pendingSince: null,
    lastWakeAt: null,
  };
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readWakeLedger(filePath, { readFileSync = fs.readFileSync } = {}) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || value.version !== LEDGER_VERSION) return emptyWakeLedger();
    const next = { ...emptyWakeLedger(), ...value };
    next.project = "evodevo";
    next.armed = value.armed === true;
    for (const key of [
      "armedAt",
      "baselineSettlementId",
      "lastSeenWaveId",
      "lastDeliveredSettlementId",
      "pendingSettlementId",
      "pendingSince",
      "lastWakeAt",
    ]) next[key] = nullableString(value[key]);
    return next;
  } catch {
    return emptyWakeLedger();
  }
}

function writeWakeLedger(filePath, ledger, { write = writePrivateFileAtomic } = {}) {
  write(filePath, `${JSON.stringify({ ...emptyWakeLedger(), ...ledger, version: LEDGER_VERSION, project: "evodevo" }, null, 2)}\n`);
}

module.exports = {
  LEDGER_VERSION,
  emptyWakeLedger,
  readWakeLedger,
  writeWakeLedger,
};
