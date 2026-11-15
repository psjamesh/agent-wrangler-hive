import { cellCounts } from './model.js';
import { needsHuman } from './request-state.js';
import { cellWaitingItems } from './waiting-model.js';

export function cellMetrics(ctx, cell) {
  const waitingItems = cellWaitingItems(ctx, cell);
  return {
    work: cellCounts(ctx.hive, cell),
    waitingItems,
    needs: cell.retired ? 0 : cell.snapshot ? (cell.requestCounts?.human ?? Object.values(cell.requests || {}).filter(needsHuman).length) : waitingItems.length,
    occupied: cell.occupiedCount || 0,
    toRead: cell.inbox?.human?.count || 0,
    toAnswer: cell.inbox?.queen?.count || 0,
  };
}
