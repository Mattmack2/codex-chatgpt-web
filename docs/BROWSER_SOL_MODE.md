# Browser Sol desktop mode

Browser Sol is the small, durable desktop workflow for the EvoDevo project. It keeps the
launcher's ordinary ChatGPT Web experience intact: the embedded page is still a normal ChatGPT
Temporary Chat, with the existing tabs, toolbar, sign-in flow, model controls, streaming view, and
manual Zero Risk mode. Browser Sol adds a compact status strip above that page; it is not a second
chat UI and it does not replace ordinary conversations.

Each automatic Browser Sol turn is leased into a fresh Temporary Chat document. For the
browser-only route, the helper ensures that document is `Personalized` before it inserts the
prompt, so ChatGPT-native connectors such as GitHub remain available on the new turn. This does
not grant local filesystem, shell, or process tools to the browser model; desktop actions still
come through the configured control-plane route. Manual/Zero Risk conversations remain
user-controlled.

## What is durable

The outer Browser Sol conversation is a native Codex task. The launcher stores only a small task
identity file under the launcher profile:

```text
<launcher profile>/browser-sol/task.json
```

The file contains the native Codex thread UUID, display title, project working directory, and a
timestamp. It does not contain task history, prompts, cookies, tokens, provider payloads, or
scientific state. Codex owns the history, compaction/checkpoint machinery, rollover, and task UI.
Opening or resuming Browser Sol uses the native `codex://threads/<uuid>` deep link and the local
Codex app-server task-control protocol. It does not create a new outer task for each wake.

The Browser Sol wake ledger is a separate, small private file:

```text
<launcher profile>/browser-sol/wake-ledger.json
```

It records only the armed project, arming baseline, last seen wave, last delivered settlement,
pending settlement, and wake timestamps. It is not a database or daemon. Writes are atomic and the
containing directory is protected as a private launcher directory.

## Status strip

The browser surface shows:

- Browser/ChatGPT `READY` or `ERROR`;
- the native Browser Sol task as connected, busy, or unavailable;
- project `evodevo`;
- Auto Wake `ARMED` or `OFF`;
- active and queued provider counts;
- the current wave and settlement identifiers;
- the last wake time and the native task's compaction/handoff context;
- `Open/Resume Browser Sol`, `Arm`/`Disarm`, and an explicit `Test Wake` action.

`Open/Resume Browser Sol` is the only control that may create the durable outer task. Automatic
wakes require an existing attachable task, so a missing or unavailable task becomes a visible
pending state instead of silently creating a task or launching scientific work.

## Wake source and exact transition rule

The launcher reads the deployed Any-Clerk automatic-wake document at:

```text
~/.local/share/any-clerk/automatic-review-wakes.json
```

The adapter is read-only and scopes itself to:

```text
project:github.com/mattmack2/evo-devo-lab
```

It reads provider counts, queued counts, wave IDs, and settlement records only. It does not enable
delivery in Any-Clerk, consume or write Any-Clerk's wake ledger, restart Any-Clerk, stop providers,
or inspect protected BLIND, T0, or Trial001 material.

The unfinished count is exactly:

```text
active_provider_count + queued_provider_count
```

A wave starts on `0 -> >0`. A wave settles on `>0 -> 0`. Startup at `0 -> 0` never wakes. The
launcher establishes a baseline when Auto Wake is armed, so historical settlements are not replayed.
The private ledger makes the same settlement idempotent across polling ticks, source-file rewrites,
launcher restarts, and temporary delivery failures. If a settlement happens while the launcher is
closed, an armed durable ledger can recover it when the launcher starts again. If the native task is
busy, compacting, handing off, or temporarily unavailable, the settlement remains pending and is
delivered only after the task can accept it.

Every automatic delivery uses this compact prompt and does not dispatch providers itself:

```text
AUTOMATIC EVODEVO WAKE
current wave settled active=0 queued=0
refresh current durable Git/Operator/Any-Clerk state, inspect returned/pushed provider work, adjudicate and continue; don't rerun paid work from lifecycle metadata, protect BLIND/T0/Trial001.
```

The prompt asks the native Browser Sol task to refresh current state and adjudicate returned work;
it is not authorization to launch a new provider wave. The task uses semantic `high` effort for the
ChatGPT Web model route. A hard-coded model name is not required by the desktop mode; if the
configured native route is unavailable, the launcher surfaces the unavailable state.

## Profile and safety boundaries

The launcher keeps its existing signed-in ChatGPT browser partition and profile configuration. The
Browser Sol ledger is additive and does not migrate, print, or copy cookies, local storage, API keys,
or tokens. The existing launcher remains the owner of the embedded browser session and its normal
bounded dead-browser timeout.

Browser Sol is project-scoped. It does not attach to an Any-Clerk working directory, and task
discovery rejects task rows whose working directory is under an Any-Clerk checkout. There is no
second history database, background scientific dispatcher, or provider-kill path in the launcher.

## Verification

The focused launcher suite covers startup, wave/settlement transitions, duplicate suppression,
arming baselines, restart recovery, queued work, busy-task deferral, compaction/handoff deferral,
concurrent ticks, unavailable source handling, explicit test wakes, task identity persistence,
native deep-link reuse, high-effort delivery, and the no-auto-create rule. The browser contract
suite additionally verifies extraction of the current ChatGPT DIL response renderer, including
completion evidence when legacy `.markdown` roots and copy buttons are absent.

For a real desktop check, run a normal Browser Sol Open/Resume action, confirm the native task opens,
then use an isolated sacrificial wake fixture or the explicit `Test Wake` button. Do not use a paid
provider launch as a wake test. Keep protected scientific evidence and the deployed Any-Clerk
process untouched.
