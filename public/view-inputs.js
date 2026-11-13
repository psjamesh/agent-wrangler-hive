const names = graph => (graph?.sessions || []).map(s => [s.sessionId, s.name, s.label, s.lastLabel]);
const beadNames = hive => Object.values(hive.beads).map(b => [b.id, b.title, b.parentId]);

export function conversationInputs(ctx, cell) {
  const thread = ctx.ui.openThread?.(cell.id);
  return JSON.stringify([
    cell.id, cell.enabled, cell.retired, cell.queenSessionId, cell.rootBeadId, cell.conversationRevision,
    thread ? cell.messages.filter(m => m.threadId === thread) : cell.messages,
    thread ? cell.threads?.find(t => t.id === thread) : cell.threads,
    thread ? null : [cell.threadsAfter, cell.threadsTruncated],
    cell.inbox, cell.requests, cell.requestCounts, cell.topicRelations,
    ctx.hive.metaEpoch, beadNames(ctx.hive), names(ctx.graph), ctx.uiVersion, ctx.ui.selectedBeadId?.(), ctx.ui.topicAboutFor?.(cell.id),
    ['hive-send', 'hive-thread-history', 'hive-thread-list', 'hive-inbox', 'hive-thread-rename', 'hive-ack', 'hive-ack-undo', 'hive-withdraw', 'hive-withdraw-undo', 'hive-deliver', 'hive-request-answer', 'hive-request-dismiss', 'hive-request-retry'].map(ctx.busy),
  ]);
}

export function mapInputs(ctx, cell) {
  const { hive, ui } = ctx;
  return JSON.stringify([
    cell ? [cell.id, cell.rootBeadId, cell.beadLayout, cell.arrangeAspect, cell.archived,
      cell.layoutWarning, cell.bindings, cell.snapshot, cell.workstreamColours, cell.workstreamShades] : Object.values(hive.cells).map(c => [c.id, c.taskId, c.enabled, c.retired, c.rootBeadId, c.queenSessionId, c.bindings,
      c.position, c.snapshot, c.inbox?.human?.count, c.inbox?.queen?.count, c.requestCounts?.human, c.launch, c.occupiedCount]),
    Object.values(hive.beads).map(b => [b.id, b.parentId, b.title, b.kind, b.status, b.ownerSessionId,
      b.createdAt, b.outcome, b.assignee, b.untracked, b.waitingFor, b.reviewState, b.reviewWorking, b.closeReason, b.closedReason, cell ? null : b.goal]),
    hive.edges, cell ? null : hive.launches, hive.backend?.snapshotComplete, hive.backend?.snapshotError, hive.backend?.snapshotBeadIds,
    (ctx.graph?.sessions || []).map(s => [s.sessionId, s.status, s.exitOutput ? true : false, s.archived, s.name, s.label, s.lastLabel]),
    ctx.graph?.tasks, cell ? ui.selectedBeadId() : ui.highlightedCell?.(), ui.placements(),
    cell ? ui.hideDoneForHive(cell.id) : null, cell ? [...ui.detachedRegions(cell.id)] : null,
    ui.showRetired?.(), ui.form('mapSearchReveal'), ui.form('wsMenu'), ui.form('key'), ctx.busy('hive-bead-move'),
  ]);
}
