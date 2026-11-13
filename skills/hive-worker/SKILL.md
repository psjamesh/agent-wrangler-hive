---
name: hive-worker
description: Use when your session takes part in a Hive cell as a worker, reviewer or other participant (it is in the cell's task, was spawned by its queen, or is bound to one of its beads), or your brief names a Hive bead. Covers finding your cell and bead, claiming work, keeping understanding and evidence current, reporting uncertainty, and releasing or handing off work cleanly.
---

# Hive worker

A Hive cell is one Agent Wrangler task with a durable work record: a graph of *beads* that Hive keeps in a Beads store. The cell's queen keeps the record coherent. You own a piece of it.

## First contact

1. Call `hive_context` with `scope: "bead"`. It returns your bead, its parent chain and direct links, its visible topics and requests, and your own claims and bindings. Pass your brief's bead as `bead_id`; otherwise it defaults to your single claimed or bound bead. If there are several, supply `bead_id` explicitly. If you take part in several cells, pass `cell_id`. With no assigned bead, omit scope to find work; the full cell read remains the queen's default.
2. A worker launched with `hive_spawn_worker` already owns its bead; verify it in context. A reviewer launched by `hive_request_review` instead has a reviewer binding on the work bead; verify it and leave the builder's claim in place. Otherwise claim your bead with `hive_claim_bead`. A claim records that your session is doing it. If someone else holds the bead, don't take it over: say so with `hive_publish` and wait for the queen.
3. If your brief has no bead, use `hive_ready` to see what can start. Claim only what your brief lets you take on.

## While you work

- Keep the bead's `summary` as the current understanding. Replace it rather than appending a log. Keep `next_action` and `waiting_for` current too. Use `hive_update_bead` for all of these.
- Add evidence as it appears with `add_evidence`: PRs, test output, review findings, measurements. Evidence says what happened; don't record a review or a merge that didn't happen.
- Titles are what the human reads on the map: a short, self-contained action or outcome in plain words, with any ticket or PR reference after the meaningful words or in the summary or evidence. Don't retitle a bead to change its scope.
- Create beads and wait for their returned ids before naming them in Hive messages, mail or reports. Never create beads and send a message naming them in the same parallel batch; copy returned ids, never guess. Pass `bead_id` for the main bead in a Hive message; ask the queen to use `hive_update_thread` if an existing topic needs a different anchor. Name the parent workstream explicitly when creating work; use the cell goal only for cross-cutting work.
- If you find more work, add it with `hive_create_beads` under the right parent. Link it with `hive_link_beads` when it really depends on something. The links are the dependencies; where beads appear in the view means nothing.
- Waiting on a prerequisite is normal. Set `status: "blocked"` or `waiting_for` with the reason. It is not a failure.
- If you are unsure of something, record what you know in the bead and publish a short, self-contained question or concern with `hive_publish` and `bead_id`. Publish only questions and concerns the human needs to see; progress stays on your bead. Post in the topic it belongs to: `reply_to` when you answer a message, `thread_id` to add to a topic, or a short `thread_title` when it starts a new subject.

For decisions or actions in this hive, use `hive_request_input` with a self-contained title and body. Do not also call `request_human_input`: that standard tool is for sessions outside Hive. Worker, reviewer and helper requests go to the cell's queen, who can answer within its authority or forward the same request to the human. A missing/archived queen routes directly to the human, labelled **No queen in this hive**. A queen answer is attributed as a queen answer; it is not human approval. Queen-stage requests and queen answers stay in the agent queue/audit and out of human views; only forwarding, a queen asking directly, or a missing queen makes a request visible to the human. Human step-in is not supported. Do not copy queued questions into the human conversation. Recover your own requests with `hive_list_my_requests`; use `hive_withdraw_request` when the answer arrived in chat or the request is no longer needed. Own-list and withdrawal still work after leaving the hive.

When asking the human to approve a blocked command or act in a specific board session, pass that full `session_id` to `hive_request_input` or `hive_publish`, with an optional `session_label` (default: Open session). This adds a one-click board link and sends nothing to that session. The session must exist on the board; archived or unavailable sessions display as plain text. Forwarding a worker or reviewer request automatically includes its requester session, alongside any explicit target. Markdown `[Open session](#session=<full id>)` links also work in messages and request bodies.

When there is a choice, always pass `options` and never list the choices only in the body; a decision or an "Options:" list without `options` is refused. Supply 2–4 `options` (at most 6), each with a stable lowercase `id`, short `label` and optional `description`. Put your recommended option first, suffix its label with `(Recommended)`, and explain the recommendation and trade-offs in the body. Omit options for open questions. Text replies are always allowed, either alone or as an optional note with a choice; `allow_free_text` is a compatibility parameter and cannot disable them. Recover answers by `answer.optionId` and `answer.text`. Queen answers can pass `option_id` with an optional `text` note to `hive_answer_request`; forwarding preserves the choices and accepts the queen’s `recommendation` in addition to the requester’s recommendation.

Membership comes from the current queen nomination, an active Hive binding, assignment to the hive's task, or the bounded dispatch grace for a launch into that task. Ancestry and board nesting alone do not enroll a helper. If you launch reviewers/helpers, pass the hive's resolved task id and include: “For decisions or actions use Hive's input tool; do not also call request_human_input. Worker/reviewer requests go to this hive's queen.” An off-task helper needs an authorized binding or deliberate task reassignment. A missing native tool is a membership or launch/resume problem: ask the queen to check rather than silently changing queues. Surface a higher-priority instruction conflict to the queen for human correction.

For a request about a specific Hive message or topic, include `[Open Hive message](<link>)` in its body, using the link from `hive_publish` or `hive_context`. An ordinary conversation reply does not answer or withdraw a native request. Pre-existing standard requests retain their original recovery/withdraw tools; never mirror them into Hive.

## Finish or hand off

- When the acceptance is met, call `hive_finish_bead` with `outcome: "done"`, a summary of what was achieved and the evidence.
- If the work should stop, use `dropped`, `superseded` or `duplicate` and say why.
- If you can't finish, leave the summary and next action accurate and release your claim with `hive_release_bead` and a reason, so someone else can pick it up. Stopping without finishing leaves the bead open; it never counts as done.
- Only the session holding a claimed bead can finish it. If you hold it, finish it yourself rather than leaving that to the queen. If someone else holds it, ask them, or ask the queen to coordinate. Don't try to close it.
- If a Hive write reports an unclear or partial outcome, don't repeat it. Hive checks the store for it, and the queen settles anything still unclear.

## Review and merge

When you hold a bead's claim and want a review, launch it yourself with `hive_spawn_worker(bead_id, role: "review", intent, commit)`. Hive uses the hive's review policy (a reviewer on a different provider from you where one is configured); your own agent, model and effort are ignored. The reviewer is bound to your bead, its verdict records on that bead, it shares your capacity slot, and the queen is told. After `changes_requested` and a fix, request the next round the same way with the new `commit`: each re-review is a new review session with its own verdict. A helper, advisor or investigation is its own bead: ask the queen to create and launch it. Never use `spawn_session`, `spawn_workflow`, `schedule_session` or `adversarial-pr-review` for Hive work (these launches are not Hive-tracked). An advisor or investigation needs its own bead: ask the queen to create and launch it; if a session was already started another way, nominate it by joining it to your bead with `hive_bind_session(bead_id, session_id, role: "review")`; a session can never nominate itself, and no session that has worked on the bead can review it. `hive_request_review` is an alias of the review role.

If you are a bound reviewer, give the verdict with `hive_review_verdict(bead_id, verdict, summary, commit)` (`approved` or `changes_requested`, with findings and the reviewed commit). It records evidence on that work and ends its review wait. There is no separate review bead. Changes requested return the work to its builder without changing its claim. Do not claim or finish the builder's work. Only a queen/coordinator may explicitly cancel the review. If a verdict receipt was interrupted, retry only the same verdict; Hive observes evidence to recover it and refuses replay while the write remains uncertain.

Follow the review and merge instructions you have: your brief, the repository and your global skills. Hive adds no gate of its own and doesn't change those instructions.

## Coordinators

If the queen bound you as `coordinator` for a workstream, you may also delegate within that workstream's goal. Follow the hive-queen skill for your scope.
