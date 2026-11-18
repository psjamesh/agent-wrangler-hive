import * as tools from '../../server/tools.js';
import { schema } from './host-schema.mjs';
export { buildContext, spawnRestriction } from '../../server/tools.js';

function bind(tool) {
  return { ...tool, inputSchema: tool.inputSchema({ host: { schema } }),
    handler(frame, args) {
      const host = frame.host ?? {};
      host.schema ??= schema;
      return tool.handler({ ...frame, host }, args);
    } };
}
export const workTools = tools.workTools.map(bind);
export const hiveTool = (...args) => bind(tools.hiveTool(...args));
export const contextTool = workTools.find(tool => tool.name === tools.contextTool.name);
export const readyTool = workTools.find(tool => tool.name === tools.readyTool.name);
export const createBeadsTool = workTools.find(tool => tool.name === tools.createBeadsTool.name);
export const updateBeadTool = workTools.find(tool => tool.name === tools.updateBeadTool.name);
export const linkBeadsTool = workTools.find(tool => tool.name === tools.linkBeadsTool.name);
export const claimBeadTool = workTools.find(tool => tool.name === tools.claimBeadTool.name);
export const releaseBeadTool = workTools.find(tool => tool.name === tools.releaseBeadTool.name);
export const bindSessionTool = workTools.find(tool => tool.name === tools.bindSessionTool.name);
export const finishBeadTool = workTools.find(tool => tool.name === tools.finishBeadTool.name);
export const publishTool = workTools.find(tool => tool.name === tools.publishTool.name);
export const updateThreadTool = workTools.find(tool => tool.name === tools.updateThreadTool.name);
export const acknowledgeInputTool = workTools.find(tool => tool.name === tools.acknowledgeInputTool.name);
export const reconcileOperationTool = workTools.find(tool => tool.name === tools.reconcileOperationTool.name);
export const deleteBeadsTool = workTools.find(tool => tool.name === tools.deleteBeadsTool.name);
export const spawnWorkerTool = workTools.find(tool => tool.name === tools.spawnWorkerTool.name);
export const reconcileWorkerTool = workTools.find(tool => tool.name === tools.reconcileWorkerTool.name);
export const requestReviewTool = workTools.find(tool => tool.name === tools.requestReviewTool.name);
export const reviewVerdictTool = workTools.find(tool => tool.name === tools.reviewVerdictTool.name);
export const cancelReviewTool = workTools.find(tool => tool.name === tools.cancelReviewTool.name);
export const handoffQueenTool = workTools.find(tool => tool.name === tools.handoffQueenTool.name);
export const reportPrWaitTool = workTools.find(tool => tool.name === tools.reportPrWaitTool.name);
export const pickupTool = workTools.find(tool => tool.name === tools.pickupTool.name);
