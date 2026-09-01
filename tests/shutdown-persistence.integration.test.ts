import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'forgeax-task-board-shutdown-test-'));
const port = 33_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;

async function startServer() {
  const child = Bun.spawn([process.execPath, join(root, 'server.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TASK_BOARD_DATA_DIR: dataDir },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/api/summary`)).ok) return child; }
    catch {}
    await Bun.sleep(20);
  }
  throw new Error(`shutdown test server did not start: ${await new Response(child.stderr).text()}`);
}

beforeAll(async () => { server = await startServer(); });
afterAll(async () => {
  server?.kill();
  await server?.exited;
  await rm(dataDir, { recursive: true, force: true });
});

test('flushes a just-created task when terminated immediately', async () => {
  const createdResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'persist-on-shutdown' }),
  });
  const created = await createdResponse.json();

  server!.kill('SIGTERM');
  expect(await server!.exited).toBe(0);
  server = await startServer();

  const restoredResponse = await fetch(`${base}/api/tasks/${created.id}`);
  expect(restoredResponse.status).toBe(200);
  expect((await restoredResponse.json()).title).toBe('persist-on-shutdown');
  expect((await stat(join(dataDir, 'tasks.json'))).mode & 0o777).toBe(0o600);
});
