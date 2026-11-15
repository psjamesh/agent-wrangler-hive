# Claude Code retains deferred MCP schemas on resume

Investigation date: 2026-11-15. Tested with Claude Code **2.1.325**, Node.js
**v24.2.0**, on macOS (Darwin 27.2.0).

## Finding

A resumed Claude Code conversation can send a saved deferred tool schema to the
Messages API even after it fetches the current MCP `tools/list` and executes
ToolSearch again. In the isolated reproduction, the saved
`deferred_tools_record` attachment supplies that schema. This is observable in
the outgoing API request, without asking a model what schema it sees.

The stale schema explains the earlier observation that an agent continued to
report a tool's `title` property while omitting its newly added `options`
property. Model anchoring alone cannot explain the captured request: the client
actually sends the older definition. This does not rule out anchoring as an
additional influence in a real conversation.

## Evidence

The probe runs a loopback MCP server and a loopback mock Messages API. The API
returns a scripted ToolSearch call followed by a text response. No paid model
inference is involved. The MCP tool's name stays `probe_tool`; only its schema
changes between launches.

| Conversation phase | MCP advertises | Outgoing API tool properties after ToolSearch |
| --- | --- | --- |
| Fresh, schema v1 | `title` | `title` |
| Resume that conversation, schema v2 | `title`, `options` | `title` |
| Fresh conversation, schema v2 | `title`, `options` | `title`, `options` |
| Resume after editing only its saved deferred record | `title`, `options` | `title`, `snapshot_marker` |

Both captured API requests in each resume phase carry the saved schema: the
first request, with the earlier ToolSearch result in history, and the next
request, after a new ToolSearch result. ToolSearch returns a `tool_reference`
with the tool's name; that result is not itself a schema body.

The transcript contains this attachment, abbreviated to the relevant fields:

```json
{
  "attachment": {
    "type": "deferred_tools_record",
    "entries": [{
      "name": "mcp__probe__probe_tool",
      "input_schema": {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": false
      },
      "defer_loading": true
    }]
  }
}
```

Adding `snapshot_marker` only to that record in the disposable transcript makes
it appear in both resumed API requests. The live mock MCP server never
advertises that property. This controlled intervention identifies persisted
record precedence over fresh discovery at the request construction boundary.
It does not identify a private function name or establish why the client makes
that choice.

Earlier real-model probes on 2026-11-14 used the same CLI version and
`claude-haiku-5-5`. Their server logs show v2 `tools/list` on resume. The agent
re-ran ToolSearch but still reported `title` only. An explicit instruction to
include `options` made the server receive that argument successfully. Thus a
successful call with a new argument was not proof that the model-visible schema
had refreshed. The mock API reproduction isolates the missing boundary in that
earlier evidence.

## Reproduce without model spend

Run from the repository root with Node.js and Claude Code 2.1.325 available:

```sh
node docs/investigations/fixtures/claude-resume-schema.mjs
```

The [probe](fixtures/claude-resume-schema.mjs) creates a unique directory under
`.scratch`, a separate Claude configuration, and two temporary loopback HTTP
listeners. It removes inherited `AW_`, `CLAUDE*` and `ANTHROPIC*` environment
settings, sets a dummy API key and local API base, disables nonessential CLI
traffic, and uses `--strict-mcp-config` and `--setting-sources ''`. It does not
connect to Agent Wrangler, use real credentials, launch a browser, or restart
any service. All four CLI launches use scripted local API responses.

It asserts every row of the table, then writes `summary.json` with only phase,
boundary and property names. The final phase edits only the transcript it just
created. It never edits an existing conversation. Generated CLI configuration
and transcripts remain private scratch artifacts; do not publish them because
they may contain local paths and automatically supplied workspace context.

The probe exits nonzero if the behavior differs. A later client that fixes this
behavior should therefore fail these reproduction assertions; this is an
investigation fixture, not a product regression test. The CLI's cost estimates
from synthetic token usage are not actual billed inference.

## Recommendation and limits

Recommend an upstream Claude Code bug report with the CLI version, this
credential-free reproduction and the boundary table. Filing that report requires
the operator's approval; this investigation does not file it.

For now, treat Agent Wrangler's resume instruction to re-run ToolSearch as
best-effort discovery guidance, not schema invalidation. A fresh conversation
is the demonstrated workaround for this schema case; merely restarting a
terminal and resuming the same conversation is not demonstrated to help. Carry
forward a concise task handoff when starting fresh. Do not patch user
transcripts as a production workaround: the record edit here is an isolated
causal probe, not a supported client operation.

No Agent Wrangler runtime change is proposed by this note. Re-running ToolSearch
cannot repair the saved-schema precedence demonstrated here. Tool renaming,
client reconnect commands, non-deferred tools, compaction, other client versions
and Codex are not evaluated.

Tools being absent after a server restart is a separate symptom. An extension
that has not loaded or is quarantined can legitimately omit its tools. This
probe performs no server restart and provides no evidence that tools stay
missing after a healthy reload. It establishes no shared cause for that symptom.
