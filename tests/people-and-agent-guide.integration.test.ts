import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'forgeax-task-board-people-test-'));
const port = 34_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  const text = await response.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { response, data };
}

beforeAll(async () => {
  server = Bun.spawn([process.execPath, join(root, 'server.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TASK_BOARD_DATA_DIR: dataDir },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/api/summary`)).ok) return; }
    catch {}
    await Bun.sleep(20);
  }
  throw new Error(`people test server did not start: ${await new Response(server.stderr).text()}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await rm(dataDir, { recursive: true, force: true });
});

test('publishes stable human and machine AI discovery paths', async () => {
  const discovery = await request('/.well-known/forgeax-task-board');
  expect(discovery.response.status).toBe(200);
  expect(discovery.data.machineGuide).toBe(`${base}/api/agent-guide`);
  expect(discovery.data.documentation).toBe(`${base}/agent-guide.md`);

  const guide = await request('/api/agent-guide');
  expect(guide.response.status).toBe(200);
  expect(guide.data.claim.requiredBody).toEqual(['agentId', 'sessionId', 'process', 'cwd']);
  expect(guide.data.peopleSemantics).toContain('human collaborators');

  const markdown = await fetch(`${base}/agent-guide.md`);
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get('content-type')).toContain('text/markdown');
  expect(await markdown.text()).toContain('标准执行生命周期');
});

test('stores multiple people and combines person with tag and status filters', async () => {
  const first = await request('/api/tasks?tag=game', {
    method: 'POST',
    body: JSON.stringify({ title: 'alice-and-bob', people: ['Alice', 'bob', 'ALICE'] }),
  });
  expect(first.response.status).toBe(201);
  expect(first.data.people).toEqual(['Alice', 'bob']);

  const second = await request('/api/tasks?tag=game', {
    method: 'POST',
    body: JSON.stringify({ title: 'alice-only', people: ['alice'], status: 'blocked' }),
  });
  expect(second.response.status).toBe(201);

  await request('/api/tasks?tag=ops', {
    method: 'POST',
    body: JSON.stringify({ title: 'outside-game', people: ['Alice'] }),
  });

  const aliceReady = await request('/api/tasks?tag=game&person=ALICE&status=ready');
  expect(aliceReady.data.map((task: { title: string }) => task.title)).toEqual(['alice-and-bob']);

  const summary = await request('/api/summary?tag=game&person=alice');
  expect(summary.data.total).toBe(2);
  expect(summary.data.ready).toBe(1);
  expect(summary.data.blocked).toBe(1);

  const people = await request('/api/people?tag=game');
  expect(people.data).toContainEqual({ person: 'alice', count: 2 });
  expect(people.data).toContainEqual({ person: 'bob', count: 1 });

  const recent = await request('/api/tasks/recent?tag=game&person=bob');
  expect(recent.data.map((task: { title: string }) => task.title)).toEqual(['alice-and-bob']);

  const patched = await request(`/api/tasks/${first.data.id}?tag=game`, {
    method: 'PATCH',
    body: JSON.stringify({ people: ['Carol'] }),
  });
  expect(patched.data.people).toEqual(['Carol']);
});

test('claim contract requires session provenance', async () => {
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'claim-provenance' }) });
  const missingSession = await request(`/api/tasks/${created.data.id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ agentId: 'agent-1', process: 'codex', cwd: '/workspace/game' }),
  });
  expect(missingSession.response.status).toBe(400);
  expect(missingSession.data.error).toBe('sessionId is required');

  const claimed = await request(`/api/tasks/${created.data.id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ agentId: 'agent-1', sessionId: 'session-1', process: 'codex', cwd: '/workspace/game' }),
  });
  expect(claimed.response.status).toBe(200);
  expect(claimed.data.claim.sessionId).toBe('session-1');
});
