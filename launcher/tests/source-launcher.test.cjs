const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

test("source launcher bootstraps the pinned Bun runtime without a virtual environment", () => {
  const script = fs.readFileSync(path.join(root, "run-app.sh"), "utf8");
  assert.match(script, /command -v bun/);
  assert.match(script, /npm exec --yes --package="bun@\$BUN_VERSION"/);
  assert.match(script, /bun run scripts\/start-launcher\.ts/);
});
