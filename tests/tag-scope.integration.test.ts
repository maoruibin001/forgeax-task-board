import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'forgeax-task-board-tag-test-'));
const port = 31_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const data = await response.json();
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
    try {
      const response = await fetch(`${base}/api/summary`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }

  throw new Error(`tag-scope test server did not start: ${await new Response(server.stderr).text()}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await rm(dataDir, { recursive: true, force: true });
});

test('tag scope filters reads and enforces the scope tag on writes', async () => {
  const globalTask = await request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'global-only', tags: ['ops'] }),
  });
  expect(globalTask.response.status).toBe(201);

  const gameTask = await request('/api/tasks?tag=game', {
    method: 'POST',
    body: JSON.stringify({ title: 'game-task', tags: ['P0', 'GAME', 'game'] }),
  });
  expect(gameTask.response.status).toBe(201);
  expect(gameTask.data.tags).toEqual(['P0', 'game']);

  const scopedList = await request('/api/tasks?tag=GAME');
  expect(scopedList.response.status).toBe(200);
  expect(scopedList.data.map((task: { title: string }) => task.title)).toEqual(['game-task']);

  const summary = await request('/api/summary?tag=game');
  expect(summary.data.total).toBe(1);
  expect(summary.data.ready).toBe(1);

  const recent = await request('/api/tasks/recent?limit=3&tag=game');
  expect(recent.data).toHaveLength(1);
  expect(recent.data[0].tags).toContain('game');

  const tags = await request('/api/tags');
  expect(tags.data).toContainEqual({ tag: 'game', count: 1 });

  const patched = await request(`/api/tasks/${gameTask.data.id}?tag=game`, {
    method: 'PATCH',
    body: JSON.stringify({ tags: ['P1'] }),
  });
  expect(patched.data.tags).toEqual(['P1', 'game']);

  const hiddenDetail = await request(`/api/tasks/${globalTask.data.id}?tag=game`);
  expect(hiddenDetail.response.status).toBe(404);
});

test('a scoped subtask cannot attach to a parent outside the tag scope', async () => {
  const parent = await request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'ops-parent', tags: ['ops'] }),
  });
  const child = await request('/api/tasks?tag=game', {
    method: 'POST',
    body: JSON.stringify({ title: 'invalid-child', parentTaskId: parent.data.id }),
  });

  expect(child.response.status).toBe(400);
  expect(child.data.error).toBe('parent task is outside the requested tag scope');
});

test('unconfigured authentication remains backward compatible', async () => {
  const response = await fetch(`${base}/`);
  expect(response.status).toBe(200);
});
