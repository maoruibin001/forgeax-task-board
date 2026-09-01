import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'forgeax-task-board-cloud-test-'));
const port = 32_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const user = 'game';
const password = 'test-only-password';
const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
let server: ReturnType<typeof Bun.spawn>;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization, 'content-type': 'application/json' },
    redirect: 'manual',
    ...init,
  });
  const text = await response.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { response, data };
}

beforeAll(async () => {
  server = Bun.spawn([process.execPath, join(root, 'server.ts')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TASK_BOARD_DATA_DIR: dataDir,
      TASK_BOARD_REQUIRED_TAG: 'game',
      TASK_BOARD_AUTH_USER: user,
      TASK_BOARD_AUTH_PASSWORD: password,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/summary`, { headers: { authorization } });
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`cloud-policy test server did not start: ${await new Response(server.stderr).text()}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await rm(dataDir, { recursive: true, force: true });
});

test('cloud policy requires Basic authentication', async () => {
  const discovery = await fetch(`${base}/.well-known/forgeax-task-board`);
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).authentication.api).toBe('HTTP Basic');

  const publicGuide = await fetch(`${base}/agent-guide.md`);
  expect(publicGuide.status).toBe(200);

  const protectedMachineGuide = await fetch(`${base}/api/agent-guide`);
  expect(protectedMachineGuide.status).toBe(401);

  const anonymous = await fetch(`${base}/api/summary`);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate')).toContain('Basic');

  const wrong = await fetch(`${base}/api/summary`, { headers: { authorization: `Basic ${Buffer.from('game:wrong').toString('base64')}` } });
  expect(wrong.status).toBe(401);
});

test('browser login creates and clears an HttpOnly session', async () => {
  const anonymousRoot = await fetch(`${base}/?tag=game`, { redirect: 'manual' });
  expect(anonymousRoot.status).toBe(302);
  expect(anonymousRoot.headers.get('location')).toContain('/login?next=');

  const loginPage = await fetch(`${base}/login`);
  expect(loginPage.status).toBe(200);
  expect(await loginPage.text()).toContain('登录游戏待办');

  const wrong = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: 'wrong' }),
  });
  expect(wrong.status).toBe(401);

  const loggedIn = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  expect(loggedIn.status).toBe(204);
  const setCookie = loggedIn.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('forgeax_task_board_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  const cookie = setCookie.split(';', 1)[0];

  const session = await fetch(`${base}/api/session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({ authenticated: true, authEnabled: true, requiredTag: 'game' });

  const board = await fetch(`${base}/?tag=game`, { headers: { cookie }, redirect: 'manual' });
  expect(board.status).toBe(200);
  expect(await board.text()).toContain('Task Board · ForgeaX');

  const loggedOut = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  expect(loggedOut.status).toBe(204);
  expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0');
});

test('cloud policy redirects the root and enforces game on every API request', async () => {
  const rootResponse = await request('/');
  expect(rootResponse.response.status).toBe(302);
  expect(rootResponse.response.headers.get('location')).toContain('tag=game');

  const created = await request('/api/tasks?tag=ops', {
    method: 'POST',
    body: JSON.stringify({ title: 'cloud-game-task', tags: ['P0'] }),
  });
  expect(created.response.status).toBe(201);
  expect(created.data.tags).toEqual(['P0', 'game']);

  const list = await request('/api/tasks?tag=ops');
  expect(list.data.map((task: { title: string }) => task.title)).toEqual(['cloud-game-task']);

  const tags = await request('/api/tags');
  expect(tags.data).toContainEqual({ tag: 'game', count: 1 });
});
