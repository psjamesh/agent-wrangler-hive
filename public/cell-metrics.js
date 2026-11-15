import { cellCounts } from './model.js';
import { cellWaitingItems } from './waiting-model.js';

export function cellMetrics(ctx, cell) {
  const waitingItems = cellWaitingItems(ctx, cell);
  return {
    work: cellCounts(ctx.hive, cell),
    waitingItems,
    needs: waitingItems.length,
    occupied: cell.occupiedCount || 0,
    toRead: cell.inbox?.human?.count || 0,
    toAnswer: cell.inbox?.queen?.count || 0,
  };
}
