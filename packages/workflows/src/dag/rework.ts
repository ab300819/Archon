/**
 * `rework:` — a completed agent node whose condition matches sends work back to an
 * upstream agent node. The target and everything downstream of it in this walk re-run;
 * nodes outside that set keep their outputs and are not dispatched again.
 */
import type { DagNode } from '../schemas';
import type { ReworkConfig } from '../schemas/agent-node';
import { evaluateCondition } from '../condition-evaluator';
import { describeExecutionNode, finishNodeExecution } from '../node-execution';
import { recordNodeState } from '../node-event-write';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';
import { formatPersistedNodeOutput, persistedExecutionOutput } from './node-output';
import { resolveRunInputs } from './references';
import { beginExecution, type RunLayersContext } from './run-context';

/** The target and every node that transitively depends on it, in this walk's layers. */
function targetAndDownstream(ctx: RunLayersContext, targetId: string): Set<string> {
  const reset = new Set([targetId]);
  // Layers are topological, so one forward pass sees every upstream member first.
  for (const node of ctx.layers.flat()) {
    if (node.depends_on?.some(dep => reset.has(dep))) reset.add(node.id);
  }
  return reset;
}

/**
 * Persist the send-back: one invalidation row per node that ran in this pass. A later row
 * supersedes a node's reusable success, so resume re-runs exactly this set, and the
 * reviewer's own row is what the snapshot counts.
 */
async function recordSendBack(
  ctx: RunLayersContext,
  reviewerPath: string,
  reset: ReadonlySet<string>
): Promise<void> {
  for (const node of ctx.layers.flat()) {
    const prior = ctx.nodeOutputs.get(node.id);
    if (!reset.has(node.id) || prior === undefined) continue;
    await recordNodeState(
      { store: ctx.deps.store, logDir: ctx.logDir },
      {
        runId: ctx.workflowRun.id,
        path: ctx.stepNamePrefix + node.id,
        node: describeExecutionNode(node),
        cache: {
          action: 'invalidated',
          invalidatingDeps: [],
          reworkBy: reviewerPath,
          prior: {
            ...persistedExecutionOutput(formatPersistedNodeOutput(prior.output, ctx.artifactsDir)),
            structured: 'structuredOutput' in prior ? prior.structuredOutput : undefined,
          },
        },
      }
    );
  }
}

async function failReviewer(
  ctx: RunLayersContext,
  node: DagNode,
  error: string,
  failureKind: 'max_reworks' | 'config'
): Promise<void> {
  getLog().warn({ nodeId: node.id, failureKind }, 'dag.rework_failed');
  const output = await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(beginExecution(ctx, node), { status: 'failed', error, failureKind })
  );
  ctx.nodeOutputs.set(node.id, output);
  await safeSendMessage(ctx.platform, ctx.conversationId, `Node '${node.id}' failed: ${error}`, {
    workflowId: ctx.workflowRun.id,
    nodeName: node.id,
  });
}

/** Rework counts a walk starts from. Loop bodies re-run in full each iteration, so only
 * the top-level walk resumes the counts its earlier passes spent. */
export function initialReworkCounts(ctx: RunLayersContext): Map<string, number> {
  return new Map(ctx.loopGroupPath.length === 0 ? ctx.priorReworks : undefined);
}

/** The node's own output when its `rework.when` matched; undefined when it did not apply. */
async function matchedRework(
  ctx: RunLayersContext,
  node: DagNode
): Promise<{ rework: ReworkConfig; feedback: string } | undefined> {
  if (node.kind !== 'agent' || node.rework === undefined) return undefined;
  const output = ctx.nodeOutputs.get(node.id);
  if (output?.state !== 'completed') return undefined;
  const { result, parsed } = evaluateCondition(
    node.rework.when,
    ctx.nodeOutputs,
    resolveRunInputs(ctx.workflowRun),
    { loopPrevOutputs: ctx.loopPrevOutputs }
  );
  if (!parsed) {
    const error = `unparseable rework.when expression "${node.rework.when}"`;
    await failReviewer(ctx, node, error, 'config');
    return undefined;
  }
  return result ? { rework: node.rework, feedback: output.output } : undefined;
}

/**
 * Send `rework.to` and its downstream back, or fail the reviewer once its budget is spent.
 * Returns the layer index to resume the walk from, or undefined when nothing was sent back.
 */
async function sendBack(
  ctx: RunLayersContext,
  node: DagNode,
  { rework, feedback }: { rework: ReworkConfig; feedback: string },
  used: Map<string, number>
): Promise<number | undefined> {
  const { to, max } = rework;
  const reviewerPath = ctx.stepNamePrefix + node.id;
  const count = used.get(reviewerPath) ?? 0;
  if (count >= max) {
    const error = `rework limit reached: sent '${to}' back ${String(max)} time(s) and still rejected`;
    await failReviewer(ctx, node, error, 'max_reworks');
    return undefined;
  }
  used.set(reviewerPath, count + 1);
  const reset = targetAndDownstream(ctx, to);
  await recordSendBack(ctx, reviewerPath, reset);
  for (const id of reset) ctx.nodeOutputs.delete(id);
  // A resumed walk must re-run the reset nodes rather than replay their earlier success.
  if (ctx.priorCompletedNodes !== undefined) {
    ctx.priorCompletedNodes = new Map(
      [...ctx.priorCompletedNodes].filter(([id]) => !reset.has(id))
    );
  }
  (ctx.reworkFeedback ??= new Map()).set(to, feedback);
  getLog().info({ nodeId: node.id, target: to, rework: count + 1, max }, 'dag.rework_sent_back');
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Node '${node.id}' sent '${to}' back for rework (${String(count + 1)}/${String(max)}).`,
    { workflowId: ctx.workflowRun.id, nodeName: node.id }
  );
  return ctx.layers.findIndex(l => l.some(n => n.id === to));
}

/**
 * Apply the first matching `rework:` in a settled layer. Returns the layer index to
 * resume the walk from, or undefined to continue forward. `used` counts round trips per
 * reviewer path (see {@link initialReworkCounts}).
 */
export async function applyRework(
  ctx: RunLayersContext,
  layer: readonly DagNode[],
  used: Map<string, number>
): Promise<number | undefined> {
  for (const node of layer) {
    const match = await matchedRework(ctx, node);
    const rewindTo = match && (await sendBack(ctx, node, match, used));
    if (rewindTo !== undefined) return rewindTo;
  }
  return undefined;
}
