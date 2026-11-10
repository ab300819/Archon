// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
  mockSendQueryDag,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { dagNodeSchema } from '../schemas';
import { validateDagStructure } from '../loader/dag-structure';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';

describe('rework: a reviewer sends work back upstream', () => {
  let testDir: string;
  const implementPrompts: string[] = [];
  let verdicts: string[] = [];
  let failImplementCall: number | undefined;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-rework-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    implementPrompts.length = 0;
    failImplementCall = undefined;
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.startsWith('IMPLEMENT')) {
        implementPrompts.push(prompt);
        if (implementPrompts.length === failImplementCall) throw new Error('provider crashed');
        yield { type: 'agent_message_chunk', text: 'implemented' };
        yield { type: 'result', sessionId: 'impl' };
        return;
      }
      const verdict = verdicts.shift() ?? 'accept';
      yield {
        type: 'result',
        sessionId: 'rev',
        structuredOutput: { verdict, notes: `NOTE-${verdict}` },
      };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function workflow(max: number) {
    const counter = join(testDir, 'prep-count');
    return {
      counter,
      wf: {
        name: 'rework-test',
        nodes: [
          {
            id: 'prep',
            kind: 'exec' as const,
            runtime: 'sh' as const,
            script: `echo x >> '${counter}'`,
          },
          {
            id: 'implement',
            kind: 'agent' as const,
            source: { kind: 'inline' as const, prompt: 'IMPLEMENT feedback=[$REWORK_FEEDBACK]' },
            depends_on: ['prep'],
          },
          {
            id: 'review',
            kind: 'agent' as const,
            source: { kind: 'inline' as const, prompt: 'REVIEW' },
            depends_on: ['implement'],
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' }, notes: { type: 'string' } },
              required: ['verdict', 'notes'],
            },
            rework: { to: 'implement', when: "$review.output.verdict == 'reject'", max },
          },
          {
            id: 'after',
            kind: 'exec' as const,
            runtime: 'sh' as const,
            script: 'printf done',
            depends_on: ['review'],
          },
        ],
      },
    };
  }

  async function run(
    max: number,
    id: string,
    resume?: { rows: Parameters<typeof foldDagResumeSnapshot>[0] }
  ) {
    const store = createMockStore();
    const { counter, wf } = workflow(max);
    const snapshot = resume && (await foldDagResumeSnapshot(resume.rows, id));
    if (snapshot) store.getDagResumeSnapshot.mockImplementation(async () => snapshot);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: wf,
        workflowRun: makeWorkflowRun(id),
        ...(snapshot ? { priorCompletedNodes: snapshot.completedNodeOutputs } : {}),
      })
    );
    const events = store.persistWorkflowEvent.mock.calls.map(([event]) => event);
    return {
      events,
      snapshot,
      prepRuns: existsSync(counter)
        ? (await readFile(counter, 'utf8')).trim().split('\n').length
        : 0,
    };
  }

  it('re-runs the target and its downstream with feedback, not the upstream prep', async () => {
    verdicts = ['reject', 'accept'];
    const { events, prepRuns } = await run(2, 'rework-once');

    expect(prepRuns).toBe(1);
    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[0]).toBe('IMPLEMENT feedback=[]');
    expect(implementPrompts[1]).toContain('NOTE-reject');
    expect(events.some(e => e.step_name === 'after' && e.event_type === 'node_completed')).toBe(
      true
    );
    expect(events.some(e => e.event_type === 'node_failed')).toBe(false);
  });

  it('fails the reviewer with max_reworks once the budget is spent', async () => {
    verdicts = ['reject', 'reject', 'reject'];
    const { events, prepRuns } = await run(1, 'rework-exhausted');

    expect(prepRuns).toBe(1);
    expect(implementPrompts).toHaveLength(2);
    const failed = events.find(e => e.step_name === 'review' && e.event_type === 'node_failed');
    expect(JSON.stringify(failed)).toContain('max_reworks');
    expect(events.some(e => e.step_name === 'after' && e.event_type === 'node_completed')).toBe(
      false
    );
  });

  it('a resumed run keeps the rework budget it already spent', async () => {
    // Pass 1: one send-back, then the re-run implement crashes.
    verdicts = ['reject'];
    failImplementCall = 2;
    const first = await run(1, 'rework-resume');
    const rows = first.events;
    const snapshot = await foldDagResumeSnapshot(rows, 'rework-resume');
    expect(snapshot.reworkCounts?.get('review')).toBe(1);
    expect([...snapshot.completedNodeOutputs.keys()]).toEqual(['prep']);

    // Pass 2: the budget is already spent, so the next rejection fails the reviewer.
    implementPrompts.length = 0;
    failImplementCall = undefined;
    verdicts = ['reject'];
    const second = await run(1, 'rework-resume', { rows });
    expect(second.prepRuns).toBe(1);
    expect(implementPrompts).toHaveLength(1);
    const failed = second.events.find(
      e => e.step_name === 'review' && e.event_type === 'node_failed'
    );
    expect(JSON.stringify(failed)).toContain('max_reworks');
  });

  it('a send-back during a resumed walk re-runs nodes it would otherwise replay', async () => {
    const reject = { verdict: 'reject', notes: 'NOTE-cached' };
    const rows = [
      { step_name: 'prep', event_type: 'node_completed', data: { node_output: 'x' } },
      { step_name: 'implement', event_type: 'node_completed', data: { node_output: 'old' } },
      {
        step_name: 'review',
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(reject), structured_output: reject },
      },
    ];
    verdicts = ['accept'];
    const { events, prepRuns } = await run(1, 'rework-replay', { rows });
    // prep was replayed from the prior pass, never executed.
    expect(prepRuns).toBe(0);
    expect(implementPrompts).toEqual(['IMPLEMENT feedback=[' + JSON.stringify(reject) + ']']);
    expect(events.some(e => e.step_name === 'after' && e.event_type === 'node_completed')).toBe(
      true
    );
  });

  it('sends work back inside a loop_group body', async () => {
    verdicts = ['reject', 'accept'];
    const store = createMockStore();
    const group = dagNodeSchema.parse({
      id: 'g',
      loop_group: {
        max_iterations: 1,
        until_bash: 'true',
        nodes: [
          { id: 'implement', prompt: 'IMPLEMENT feedback=[$REWORK_FEEDBACK]' },
          {
            id: 'review',
            prompt: 'REVIEW',
            depends_on: ['implement'],
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' }, notes: { type: 'string' } },
              required: ['verdict', 'notes'],
            },
            rework: { to: 'implement', when: "$review.output.verdict == 'reject'", max: 1 },
          },
        ],
      },
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: { name: 'rework-loop', nodes: [group] },
        workflowRun: makeWorkflowRun('rework-loop'),
      })
    );
    const events = store.persistWorkflowEvent.mock.calls.map(([event]) => event);
    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[1]).toContain('NOTE-reject');
    expect(events.some(e => e.step_name === 'g' && e.event_type === 'node_completed')).toBe(true);
    expect(events.some(e => e.event_type === 'node_failed')).toBe(false);
  });

  it('rejects a rework target that is not upstream', () => {
    const nodes = [
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b', rework: { to: 'c', when: "$b.output == 'x'", max: 1 } },
      { id: 'c', prompt: 'c', depends_on: ['b'] },
    ].map(n => dagNodeSchema.parse(n));
    expect(validateDagStructure(nodes)).toContain("rework.to 'c' is not an upstream dependency");
  });
});
