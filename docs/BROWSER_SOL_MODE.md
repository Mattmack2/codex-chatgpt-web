# Browser Sol workspace mode

Browser Sol is the launcher’s persistent project-conversation mode. It keeps one native Codex
conversation for each registered project and lets Any-Clerk request a semantic continuation after a
project wave has settled. The ChatGPT Web work used by each Codex turn remains a fresh Temporary Chat
epoch owned by the existing BrowserHost; those browser epochs are not a second history store.

## Ownership boundary

The normal desktop Codex app remains the conversation owner. The launcher does not start a second
Codex app-server, does not write Codex state or queue databases, and does not use a `codex://` handoff.
It uses the first-party installed CLI seam:

```text
codex queue --thread <UUID> --message <TEXT>
```

The first explicit **Start conversation** action creates the native conversation with the installed
CLI’s `codex exec --json` command in a read-only sandbox. The launcher stores only the returned
conversation UUID and project metadata. Follow-up automatic wakes use `codex queue`; the native Codex
owner performs the actual turn, compaction, approvals, and browser routing.

The launcher reads native rollout metadata only to distinguish an idle native conversation from a
manual or automatic turn already in progress. It never copies the rollout transcript into launcher
state.

## Workspace registry

The registry is private launcher data at:

```text
<launcher user data>/browser-sol/workspaces.json
```

Its schema is `browser-sol-workspaces/v1`. Each entry contains the project identity and directory,
the one native Codex conversation identity, the per-project Automation toggle, and the minimum
settlement dedupe markers (`baselineSettlementId`, `pendingSettlementId`, and
`lastDeliveredSettlementId`). It does not contain provider counts, Any-Clerk invocation history,
ChatGPT messages, or a second conversation transcript. The first launch migrates the earlier
single-project Browser Sol identity and wake markers when those files exist.

EvoDevo is the first seeded project:

```text
project:github.com/mattmack2/evo-devo-lab
```

Additional projects can be added in the Browser Sol workspace panel with a `project:<identity>` key
and an absolute project directory. The same registry and scheduler handle them without project-name
branches.

## Any-Clerk settlement authority

The default source is:

```text
~/.local/share/any-clerk/automatic-review-wakes.json
```

Override it with `BROWSER_SOL_WAKE_SOURCE_PATH`. The launcher accepts the
`any-clerk-automatic-review-wakes/v1` document only when the configured project record currently
reports `provider_count == 0` and `queued_count == 0`, and its `settlement_id` has a matching
project/wave settlement record with zero work after settlement. It does not reconstruct a 2 → 1 → 0
transition from previous counts and does not maintain a competing wave state machine.

When Automation is enabled, the current published settlement is recorded as the baseline. A later
published settlement becomes a tiny durable pending item. After a successful `codex queue`, that
settlement ID is marked delivered. A restart therefore does not replay the same settlement, while a
new Any-Clerk settlement remains eligible.

## Scheduling and manual priority

One global scheduler polls all registered workspaces. Pending settlements are ordered by observation
time and project key. Before any automatic wake, it refreshes native Codex activity for every project;
if any project is busy, starting, or not observable, automatic delivery waits. This gives manual
Codex work priority and prevents two semantic Browser Sol wakes from being queued concurrently.

The selected project’s panel shows the native conversation readiness, Any-Clerk source health, pending
settlement state, and Automation On/Off control. **Test wake** is explicit and never claims or marks
an Any-Clerk settlement delivered.

## Development and dogfood

Run the launcher from source with the repository’s normal command:

```bash
bun run app
```

For a non-default Any-Clerk source during local dogfood:

```bash
BROWSER_SOL_WAKE_SOURCE_PATH=/absolute/path/automatic-review-wakes.json bun run app
```

The browser-only provider path explicitly makes each fresh ChatGPT Temporary Chat Personalized before
connector-capable prompts are attached. Response extraction accepts the DIL renderer’s top-level
`data-dil-widget-copy-target` root and can prove completion without relying on the legacy Markdown
copy action. Existing BrowserHost ownership, retained browser surfaces, and native Codex compaction
remain unchanged.

The normal focused gates are:

```bash
node --test launcher/tests/browser-sol.test.cjs
bun test tests/runtime-layout.test.ts tests/browser-worker-contract.test.ts
bun run launcher:typecheck
```

The installed Codex CLI must expose `codex queue --help`; otherwise the launcher reports the owner
bridge as unavailable rather than creating a competing transport.
