import { parseAcceptance, completionError, type AcceptanceCriterion } from './acceptance';
import { verificationBasis, verificationView, verificationError, type Verification } from './verification';
import { join, dirname, resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ROOT = import.meta.dir;
const DATA_DIR = process.env.TASK_BOARD_DATA_DIR ? resolve(process.env.TASK_BOARD_DATA_DIR) : join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'tasks.json');
const PORT = Number(process.env.PORT ?? 19080);
const LEASE_MS = 30 * 60 * 1000;
const TZ = process.env.TASK_TIMEZONE ?? 'Asia/Shanghai';
const HOST = process.env.TASK_BOARD_HOST ?? '0.0.0.0';
const REQUIRED_TAG = normalizeTag(process.env.TASK_BOARD_REQUIRED_TAG);
const AUTH_USER = String(process.env.TASK_BOARD_AUTH_USER ?? '');
const AUTH_PASSWORD = String(process.env.TASK_BOARD_AUTH_PASSWORD ?? '');
const SESSION_COOKIE = 'forgeax_task_board_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

type Status = 'inbox' | 'ready' | 'claimed' | 'blocked' | 'done' | 'cancelled';
type Priority = 'urgent' | 'high' | 'normal' | 'low';
type ResourceKind = 'requirement' | 'bug' | 'acceptance_doc' | 'acceptance_artifact';
type TaskResource = { id: string; kind: ResourceKind; title: string; url: string; note: string; addedAt: string; addedBy: string };
type TaskEvent = { id: string; type: 'created' | 'claimed' | 'progress' | 'renewed' | 'released' | 'blocked' | 'completed' | 'updated' | 'lease_expired' | 'verification_recorded' | 'verification_invalidated'; verification?: Verification; at: string; actor: string; note?: string; progress?: number };
type Task = {
  id: string; title: string; description: string; status: Status; priority: Priority;
  createdAt: string; updatedAt: string; deadline: string | null; tags: string[]; people: string[];
  projectSlug: string; assignee: { kind: 'human' | 'agent'; id: string; name?: string; process?: string; cwd?: string } | null;
  claim: { agentId: string; sessionId?: string; process?: string; cwd?: string; claimedAt: string; leaseUntil: string } | null;
  parentTaskId: string | null; resources: TaskResource[]; acceptanceCriteria: AcceptanceCriterion[];
  test?: boolean; verification?: Verification;
  completedAt: string | null; completedBy: string | null; result: string; blockedReason: string; progress: number; history: TaskEvent[];
};

const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const resourceKinds: ResourceKind[] = ['requirement', 'bug', 'acceptance_doc', 'acceptance_artifact'];

function compareTasks(a: Task, b: Task) {
  const aHasDeadline = Boolean(a.deadline);
  const bHasDeadline = Boolean(b.deadline);

  // Tasks with a deadline are ordered chronologically. If neither task has
  // one, priority is the useful fallback ordering.
  if (aHasDeadline && bHasDeadline) return Date.parse(a.deadline!) - Date.parse(b.deadline!);
  if (aHasDeadline !== bHasDeadline) return Number(bHasDeadline) - Number(aHasDeadline);
  return priorityRank[a.priority] - priorityRank[b.priority];
}

const seed: Task[] = [
  makeTask({ title: '定义本周最重要的三个目标', description: '把本周工作拆成可执行的结果。', priority: 'urgent', deadline: todayAt(18), tags: ['planning'] }),
  makeTask({ title: '为 Hellforge 补一轮浏览器验收', description: '验证启动、Play、核心战斗和错误日志。', priority: 'high', projectSlug: 'hellforge', deadline: addDays(1, 17), tags: ['qa', 'hellforge'] }),
  makeTask({ title: '整理 Agent 任务协作规则', description: '记录领取、续租、阻塞和交付格式。', priority: 'normal', tags: ['agents'] }),
];

function todayAt(hour: number) { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString(); }
function addDays(days: number, hour: number) { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); }
function now() { return new Date().toISOString(); }
function normalizeParentId(value: unknown) { const id = String(value ?? '').trim(); return id || null; }
function normalizeTag(value: unknown) { return String(value ?? '').trim().toLowerCase(); }
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const tag = String(item ?? '').trim();
    const key = normalizeTag(tag);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
}
function normalizePeople(value: unknown): string[] { return normalizeTags(value); }
function scopedTag(url: URL) { return REQUIRED_TAG || normalizeTag(url.searchParams.get('tag')); }
function scopedPerson(url: URL) { return normalizeTag(url.searchParams.get('person')); }
function hasTag(task: Task, tag: string) { return !tag || normalizeTags(task.tags).some((item) => normalizeTag(item) === tag); }
function hasPerson(task: Task, person: string) { return !person || normalizePeople(task.people).some((item) => normalizeTag(item) === person); }
function ensureTag(value: unknown, tag: string) {
  const tags = normalizeTags(value);
  const existing = tags.findIndex((item) => normalizeTag(item) === tag);
  if (tag && existing >= 0) tags[existing] = tag;
  else if (tag) tags.push(tag);
  return tags;
}
function normalizeResources(value: unknown): TaskResource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const input = item as Record<string, unknown>;
    const kind = resourceKinds.includes(input.kind as ResourceKind) ? input.kind as ResourceKind : null;
    const title = String(input.title ?? '').trim();
    const url = String(input.url ?? '').trim();
    if (!kind || !title || !url) return [];
    return [{ id: String(input.id ?? crypto.randomUUID()), kind, title, url, note: String(input.note ?? ''), addedAt: String(input.addedAt ?? now()), addedBy: String(input.addedBy ?? 'human') }];
  });
}
function makeTask(input: Partial<Task> & Pick<Task, 'title'>): Task {
  const t = now();
  const task = { test: input.test === true, id: crypto.randomUUID(), title: input.title, description: input.description ?? '', status: input.status ?? 'ready', priority: input.priority ?? 'normal', createdAt: input.createdAt ?? t, updatedAt: t, deadline: input.deadline ?? null, tags: normalizeTags(input.tags), people: normalizePeople(input.people), projectSlug: input.projectSlug ?? '', assignee: input.assignee ?? null, claim: input.claim ?? null, parentTaskId: normalizeParentId(input.parentTaskId), resources: normalizeResources(input.resources), acceptanceCriteria: parseAcceptance(input.acceptanceCriteria ?? []).criteria, completedAt: null, completedBy: null, result: input.result ?? '', blockedReason: '', progress: input.progress ?? 0, history: input.history ?? [] } as Task;
  task.history.push({ id: crypto.randomUUID(), type: 'created', at: t, actor: 'human' });
  return task;
}

let tasks: Task[] = [];
const clients = new Set<ReadableStreamDefaultController>();
let lastReminderDate = '';

async function load() {
  await mkdir(DATA_DIR, { recursive: true });
  try { tasks = JSON.parse(await Bun.file(DATA_FILE).text()); tasks = tasks.map((task) => ({ ...task, tags: normalizeTags(task.tags), people: normalizePeople(task.people), progress: task.progress ?? (task.status === 'done' ? 100 : 0), history: task.history ?? [], claim: task.claim ? { ...task.claim, process: task.claim.process, cwd: task.claim.cwd } : null, assignee: task.assignee ? { ...task.assignee, process: task.assignee.process, cwd: task.assignee.cwd } : null })); }
  catch { tasks = seed; await save(); }
  tasks = tasks.map((task) => ({ ...task, parentTaskId: normalizeParentId(task.parentTaskId), resources: normalizeResources(task.resources), acceptanceCriteria: task.acceptanceCriteria === undefined ? [] : (parseAcceptance(task.acceptanceCriteria).error ? [{id:'invalid-record',criterion:'原验收记录格式异常，须核对恢复',status:'pending',evidence:''}] : parseAcceptance(task.acceptanceCriteria).criteria) }));
  expireLeases();
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
async function save() {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await Bun.write(tmp, JSON.stringify(tasks, null, 2));
  await chmod(tmp, 0o600);
  await Bun.$`mv ${tmp} ${DATA_FILE}`;
}
function enqueueSave() { saveQueue = saveQueue.then(save, save); return saveQueue; }
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => void enqueueSave().catch((error) => console.error('[task-board] save failed', error)), 30); }
async function flushPendingSave() { clearTimeout(saveTimer); await enqueueSave(); }
function broadcast(event: unknown) { const data = `data: ${JSON.stringify(event)}\n\n`; for (const c of clients) { try { c.enqueue(data); } catch { clients.delete(c); } } }
function record(t: Task, type: TaskEvent['type'], actor: string, note?: string, progress?: number) { t.history ??= []; t.history.push({ id: crypto.randomUUID(), type, at: now(), actor, ...(note ? { note } : {}), ...(progress === undefined ? {} : { progress }) }); }
function touch(t: Task) {
  const v = t.verification;
  if (v && !['pending','invalidated'].includes(v.status) && (v.basis !== verificationBasis(t) || t.status !== 'done')) {
    t.verification = {...v, status:'invalidated', invalidatedAt:now(), reason:'交付结果、验收依据或完成状态已变化，需重新验证'};
    record(t, 'verification_invalidated', t.history.at(-1)?.actor ?? 'system', t.verification.reason);
    t.history.at(-1)!.verification = {...t.verification};
  }
  t.updatedAt = now(); persist(); broadcast({ type:'task.updated', task:t });
}
function expireLeases() { const time = Date.now(); let changed = false; for (const t of tasks) if (t.status === 'claimed' && t.claim && Date.parse(t.claim.leaseUntil) <= time) { const agentId = t.claim.agentId; t.status = 'ready'; t.claim = null; t.assignee = null; record(t, 'lease_expired', agentId, 'Claim lease expired; task returned to ready'); t.updatedAt = now(); changed = true; broadcast({ type: 'task.lease_expired', taskId: t.id }); } if (changed) persist(); }
function find(id: string) { return tasks.find((t) => t.id === id); }
function taskSummary(t: Task) { return { test: t.test === true, verification: verificationView(t), latestReport: taskReport(t), id: t.id, title: t.title, status: t.status, priority: t.priority, progress: t.progress, deadline: t.deadline, tags: t.tags, people: t.people, projectSlug: t.projectSlug, parentTaskId: t.parentTaskId, updatedAt: t.updatedAt, assignee: t.assignee, claim: t.claim }; }
function taskReport(t: Task) {
  const claimIndex = t.claim ? t.history.findLastIndex(event => event.type === 'claimed'
    && event.actor === t.claim!.agentId && event.at === t.claim!.claimedAt) : -1;
  // Event order disambiguates progress/release/re-claim within the same millisecond.
  const history = claimIndex >= 0 ? t.history.slice(claimIndex + 1) : t.history;
  const report = [...history].reverse().find(event =>
    ['progress', 'blocked', 'completed', 'released', 'lease_expired'].includes(event.type)
    && (claimIndex >= 0 || !t.claim || Date.parse(event.at) > Date.parse(t.claim.claimedAt)));
  return report ?? null;
}
// A read-only, single-source snapshot for the homepage. No parent lifecycle is changed.
function boardTask(t: Task) {
  return { ...taskSummary(t), description: t.description, resources: t.resources,
    subtaskCount: tasks.filter(child => child.parentTaskId === t.id && hasTag(child, REQUIRED_TAG)).length,
    blockedReason: t.blockedReason };
}
function mainTaskOf(t: Task) { let current = t; const seen = new Set<string>(); while (current.parentTaskId && !seen.has(current.id)) { seen.add(current.id); const parent = find(current.parentTaskId); if (!parent) break; current = parent; } return current; }
function parentError(taskId: string | null, parentTaskId: string | null, tag = '') {
  if (!parentTaskId) return null;
  if (taskId && taskId === parentTaskId) return 'a task cannot be its own parent';
  const parent = find(parentTaskId);
  if (!parent) return 'parent task not found';
  if (parent.parentTaskId) return 'subtasks can only belong to a main task';
  if (tag && !hasTag(parent, tag)) return 'parent task is outside the requested tag scope';
  return null;
}
function serializeTask(t: Task, detail = false, tag = '') {
  const children = tasks.filter((child) => child.parentTaskId === t.id && hasTag(child, tag));
  const base = { ...t, verification: verificationView(t), verificationBasis: verificationBasis(t), latestReport: taskReport(t), isMainTask: !t.parentTaskId, subtaskCount: children.length };
  if (!detail) return base;
  const parentCandidate = t.parentTaskId ? find(t.parentTaskId) : null;
  const parent = parentCandidate && hasTag(parentCandidate, tag) ? parentCandidate : null;
  const main = mainTaskOf(t);
  const resourcesByKind = Object.fromEntries(resourceKinds.map((kind) => [kind, t.resources.filter((resource) => resource.kind === kind)]));
  return { ...base, parentTask: parent ? taskSummary(parent) : null, mainTask: main.id !== t.id && hasTag(main, tag) ? taskSummary(main) : null, subtasks: children.sort(compareTasks).map(taskSummary), resourcesByKind };
}
function json(data: unknown, status = 200, headers: HeadersInit = {}) { return Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } }); }
async function body(req: Request) { try { return await req.json(); } catch { return {}; } }
function pathId(url: URL) { return decodeURIComponent(url.pathname.split('/')[3] ?? ''); }
function safeEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
function authEnabled() { return Boolean(AUTH_USER || AUTH_PASSWORD); }
function credentialsConfigured() { return Boolean(AUTH_USER && AUTH_PASSWORD); }
function validCredentials(user: string, password: string) {
  if (!credentialsConfigured()) return false;
  const userMatches = safeEqual(user, AUTH_USER);
  const passwordMatches = safeEqual(password, AUTH_PASSWORD);
  return userMatches && passwordMatches;
}
function basicAuthorized(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 && validCredentials(decoded.slice(0, separator), decoded.slice(separator + 1));
  } catch { return false; }
}
function sessionSignature(issuedAt: string) { return createHmac('sha256', AUTH_PASSWORD).update(`${AUTH_USER}:${issuedAt}`).digest('hex'); }
function sessionToken() { const issuedAt = String(Date.now()); return `${issuedAt}.${sessionSignature(issuedAt)}`; }
function cookieValue(req: Request, name: string) {
  const cookie = req.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}
function sessionAuthorized(req: Request) {
  if (!credentialsConfigured()) return false;
  const [issuedAt, signature, extra] = cookieValue(req, SESSION_COOKIE).split('.');
  const age = Date.now() - Number(issuedAt);
  return !extra && /^\d+$/.test(issuedAt ?? '') && /^[a-f0-9]{64}$/.test(signature ?? '') && age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000 && safeEqual(signature, sessionSignature(issuedAt));
}
function authorized(req: Request) {
  if (!authEnabled()) return true;
  if (!credentialsConfigured()) return false;
  return basicAuthorized(req) || sessionAuthorized(req);
}
function unauthorized() { return json({ error: 'Authentication required' }, 401, { 'www-authenticate': 'Basic realm="ForgeaX Game Task Board", charset="UTF-8"' }); }
function sessionCookie(token: string, maxAge = SESSION_MAX_AGE_SECONDS) { return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`; }
function scopedRoot() { return REQUIRED_TAG ? `/?tag=${encodeURIComponent(REQUIRED_TAG)}` : '/'; }
function loginRedirect(url: URL) {
  const login = new URL('/login', url);
  login.searchParams.set('next', `${url.pathname}${url.search}${url.hash}`);
  return Response.redirect(login, 302);
}
async function login(req: Request) {
  if (!credentialsConfigured()) return json({ error: 'Authentication is not configured correctly' }, 503);
  const input = await body(req);
  if (!validCredentials(String(input.username ?? ''), String(input.password ?? ''))) return json({ error: '用户名或密码不正确' }, 401);
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(sessionToken()), 'cache-control': 'no-store' } });
}
function logout() { return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie('', 0), 'cache-control': 'no-store' } }); }
function agentGuide(url: URL) {
  const origin = url.origin;
  return {
    name: 'ForgeaX Task Board', apiVersion: 1,
    scope: { requiredTag: REQUIRED_TAG || null, personFilter: 'case-insensitive exact match via ?person=<name>' },
    authentication: { api: credentialsConfigured() ? 'HTTP Basic' : 'none', browser: credentialsConfigured() ? 'form login + HttpOnly session cookie' : 'none', credentials: 'obtain out of band from the board owner' },
    discovery: `${origin}/.well-known/forgeax-task-board`, documentation: `${origin}/agent-guide.md`, machineGuide: `${origin}/api/agent-guide`,
    taskQueries: {
      boardSnapshot: '/api/board',
      boardSnapshotSemantics: 'Atomic authorized-instance snapshot with sourceAt and main/child tasks; browser filters apply to each task. A valid claim is a lease, not proof of live execution.',
      readyMainTasks: '/api/tasks?status=ready&topLevel=true',
      byPerson: '/api/tasks?status=ready&topLevel=true&person=<name>',
      people: '/api/people?topLevel=true',
      detail: '/api/tasks/<taskId>',
    },
    claim: { method: 'POST', path: '/api/tasks/<taskId>/claim', requiredBody: ['agentId', 'sessionId', 'process', 'cwd'], leaseMinutes: LEASE_MS / 60_000 },
    verification: { path: '/api/tasks/<taskId>/verification', method: 'POST', requiredBody: ['status','reviewer','evidence','expectedBasis'], rule: '独立验证阶段，保留原status；仅done且逐项通过、有交付结果及验证证据才能verified。旧done为独立验证阶段未登记pending，保留历史验收事实；交付/标准变化使验证失效。reviewer为署名，不是认证身份。' },
    completion: {criteria:'acceptanceCriteria[{id,criterion,status:pending|passed|failed,evidence}]', rule:'有标准时逐项实际验收通过并填写证据才完成；未验收/未通过标记blocked，交个人分身判断。complete与PATCH/新建done使用同一门槛；改变标准使原证据失效。'},
    lifecycle: [
      'Discover and list ready tasks; GET /api/tasks returns a JSON array.',
      'Read the full task detail immediately before claiming.',
      'Claim exactly one task and retain the returned lease.',
      'Report progress and renew the lease before it expires.',
      'Finish with complete, or explicitly block/release the task.',
    ],
    peopleSemantics: 'people[] contains human collaborators/owners; claim contains the single active AI lease holder.',
  };
}
function discovery(url: URL) {
  const guide = agentGuide(url);
  return json({ name: guide.name, apiVersion: guide.apiVersion, authentication: guide.authentication, scope: guide.scope, documentation: guide.documentation, machineGuide: guide.machineGuide });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url); expireLeases();
  if (url.pathname === '/api/session' && req.method === 'GET') return json({ authenticated: true, authEnabled: authEnabled(), requiredTag: REQUIRED_TAG || null });
  if (url.pathname === '/api/agent-guide' && req.method === 'GET') return json(agentGuide(url));
  if (url.pathname === '/api/events') {
    const stream = new ReadableStream({ start(controller) { clients.add(controller); controller.enqueue(`data: ${JSON.stringify({ type: 'connected' })}\n\n`); }, cancel(controller) { clients.delete(controller); } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }
  if (url.pathname === '/api/board' && req.method === 'GET') {
    return json({ sourceAt: now(), requiredTag: REQUIRED_TAG || null,
      tasks: tasks.filter(task => hasTag(task, REQUIRED_TAG)).sort(compareTasks).map(boardTask) });
  }
  if (url.pathname === '/api/summary') {
    const topLevelOnly = url.searchParams.get('topLevel') === 'true'; const tag = scopedTag(url); const person = scopedPerson(url);
    const filtered = tasks.filter((t) => (!topLevelOnly || !t.parentTaskId) && hasTag(t, tag) && hasPerson(t, person));
    const active = filtered.filter((t) => !['done', 'cancelled'].includes(t.status));
    return json({ total: filtered.length, ready: active.filter((t) => t.status === 'ready' || t.status === 'inbox').length, claimed: active.filter((t) => t.status === 'claimed').length, blocked: active.filter((t) => t.status === 'blocked').length, overdue: active.filter((t) => t.deadline && Date.parse(t.deadline) < Date.now()).length, dueToday: active.filter((t) => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length });
  }
  if (url.pathname === '/api/tags' && req.method === 'GET') {
    const project = url.searchParams.get('projectSlug'); const topLevelOnly = url.searchParams.get('topLevel') === 'true'; const person = scopedPerson(url); const counts = new Map<string, number>();
    for (const task of tasks) if (hasTag(task, REQUIRED_TAG) && hasPerson(task, person) && (!topLevelOnly || !task.parentTaskId) && (!project || task.projectSlug === project)) for (const tag of normalizeTags(task.tags)) { const key = normalizeTag(tag); counts.set(key, (counts.get(key) ?? 0) + 1); }
    return json([...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
  }
  if (url.pathname === '/api/people' && req.method === 'GET') {
    const project = url.searchParams.get('projectSlug'); const topLevelOnly = url.searchParams.get('topLevel') === 'true'; const tag = scopedTag(url); const counts = new Map<string, { person: string; count: number }>();
    for (const task of tasks) if (hasTag(task, tag) && (!topLevelOnly || !task.parentTaskId) && (!project || task.projectSlug === project)) for (const person of normalizePeople(task.people)) { const key = normalizeTag(person); const current = counts.get(key); counts.set(key, { person: current?.person ?? person, count: (current?.count ?? 0) + 1 }); }
    return json([...counts.values()].sort((a, b) => b.count - a.count || a.person.localeCompare(b.person)));
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const status = url.searchParams.get('status'); const priority = url.searchParams.get('priority'); const search = (url.searchParams.get('search') ?? '').toLowerCase(); const project = url.searchParams.get('projectSlug'); const topLevelOnly = url.searchParams.get('topLevel') === 'true'; const tag = scopedTag(url); const person = scopedPerson(url);
    let result = tasks.filter((t) => (!topLevelOnly || !t.parentTaskId) && hasTag(t, tag) && hasPerson(t, person) && (!status || t.status === status) && (!priority || t.priority === priority) && (!project || t.projectSlug === project) && (!search || `${t.id} ${t.title} ${t.description} ${t.tags.join(' ')} ${t.people.join(' ')} ${t.projectSlug} ${t.resources.map((resource) => `${resource.title} ${resource.url} ${resource.note}`).join(' ')}`.toLowerCase().includes(search)));
    result = result.sort(compareTasks);
    return json(result.map((task) => serializeTask(task, false, tag)));
  }
  if (url.pathname === '/api/tasks/recent' && req.method === 'GET') { const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 3) || 3, 1), 10); const tag = scopedTag(url); const person = scopedPerson(url); return json(tasks.filter((task) => !task.parentTaskId && hasTag(task, tag) && hasPerson(task, person)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit).map(taskSummary)); }
  if (url.pathname === '/api/tasks' && req.method === 'POST') { const input = await body(req); if ('verification' in input) return json({error:'请通过独立verification入口记录验证，不可直接写入验证状态'},400); if (!String(input.title ?? '').trim()) return json({ error: 'title is required' }, 400); const tag = scopedTag(url); const parentTaskId = normalizeParentId(input.parentTaskId); const error = parentError(null, parentTaskId, tag); if (error) return json({ error }, 400); const acceptance = parseAcceptance(input.acceptanceCriteria ?? []); if (acceptance.error) return json({error:acceptance.error},400); if(input.status === 'done') { const error=completionError(acceptance.criteria); if(error)return json({error},409); if(acceptance.criteria.length && !String(input.result??'').trim())return json({error:'请填写验收后的实际交付结果'},409); } const task = makeTask({ ...input, acceptanceCriteria:acceptance.criteria, tags: ensureTag(input.tags, tag), parentTaskId }); tasks.unshift(task); touch(task); return json(serializeTask(task, true, tag), 201); }
  if (!url.pathname.startsWith('/api/tasks/')) return json({ name: 'ForgeaX Task Board', timezone: TZ });
  const tag = scopedTag(url); const person = scopedPerson(url); const id = pathId(url); const task = find(id); if (!task || !hasTag(task, tag) || !hasPerson(task, person)) return json({ error: 'task not found' }, 404);
  if (req.method === 'GET') return json(serializeTask(task, true, tag));
  if (req.method === 'DELETE' && url.pathname.split('/').length === 4) { tasks = tasks.filter((t) => t.id !== id && t.parentTaskId !== id); persist(); broadcast({ type: 'task.deleted', taskId: id }); return json({ ok: true }); }
  const action = url.pathname.split('/')[4]; const input = await body(req);
  if ('verification' in input) return json({error:'请通过独立verification入口记录验证，不可直接写入验证状态'},400);
  if (action === 'verification' && req.method === 'POST') {
    const error = verificationError(task, input);
    if (error) return json({error},409);
    task.verification = { status:input.status, reviewer:input.reviewer.trim(), at:now(), evidence:input.evidence.trim(), basis:verificationBasis(task) };
    record(task, 'verification_recorded', task.verification.reviewer, task.verification.evidence);
    task.history.at(-1)!.verification = {...task.verification};
    touch(task); return json(serializeTask(task, true, tag));
  }
  const acceptance = parseAcceptance('acceptanceCriteria' in input ? input.acceptanceCriteria : task.acceptanceCriteria);
  if(acceptance.error)return json({error:acceptance.error},400);
  if ('acceptanceCriteria' in input && task.acceptanceCriteria.some(old => !acceptance.criteria.some(next => next.id === old.id))) return json({error:'已登记的验收项不可移除；标准变更请保留原项并重新验收'},409);
  // A changed criterion invalidates its old evidence and must pass again.
  for(const next of acceptance.criteria) { const old=task.acceptanceCriteria.find(old=>old.id===next.id); if(old && old.criterion!==next.criterion){next.status='pending';next.evidence='';} }
  if(action==='complete' || (req.method==='PATCH' && input.status==='done')) { const error=completionError(action==='complete'?task.acceptanceCriteria:acceptance.criteria,task.acceptanceCriteria); if(error)return json({error,acceptancePending:true},409); if(acceptance.criteria.length && !String((action==='complete'?input.result:(input.result??task.result))??'').trim())return json({error:'请填写验收后的实际交付结果'},409); }
  if (action === 'claim') { if (task.status === 'claimed' && task.claim) return json({ error: 'task is already claimed', claim: task.claim }, 409); if (['done', 'cancelled'].includes(task.status)) return json({ error: 'task is not claimable' }, 409); const agentId = String(input.agentId ?? '').trim(); if (!agentId) return json({ error: 'agentId is required' }, 400); const sessionId = String(input.sessionId ?? '').trim(); if (!sessionId) return json({ error: 'sessionId is required' }, 400); const process = String(input.process ?? input.processName ?? '').trim(); const cwd = String(input.cwd ?? input.workdir ?? '').trim(); if (!process) return json({ error: 'process is required' }, 400); if (!cwd) return json({ error: 'cwd is required' }, 400); const claimedAt = now(); task.status = 'claimed'; task.claim = { agentId, sessionId, process, cwd, claimedAt, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() }; task.assignee = { kind: 'agent', id: agentId, name: input.agentName, process, cwd }; record(task, 'claimed', agentId, input.note); touch(task); return json(serializeTask(task, true, tag)); }
  if (action === 'renew') { if (!task.claim || task.claim.agentId !== input.agentId) return json({ error: 'only the current agent can renew' }, 403); task.claim.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString(); record(task, 'renewed', input.agentId, input.note); touch(task); return json(serializeTask(task, true, tag)); }
  if (action === 'progress') { if (!task.claim || task.claim.agentId !== input.agentId) return json({ error: 'only the current agent can report progress' }, 403); const progress = Number(input.progress); if (!Number.isFinite(progress) || progress < 0 || progress > 100) return json({ error: 'progress must be between 0 and 100' }, 400); task.progress = Math.round(progress); if (input.status === 'blocked') { task.status = 'blocked'; task.blockedReason = String(input.note ?? ''); record(task, 'blocked', input.agentId, task.blockedReason, task.progress); } else { task.status = 'claimed'; record(task, 'progress', input.agentId, input.note, task.progress); } touch(task); return json(serializeTask(task, true, tag)); }
  if (action === 'release') { if (task.claim && task.claim.agentId !== input.agentId) return json({ error: 'only the current agent can release' }, 403); task.status = 'ready'; record(task, 'released', input.agentId ?? 'human', input.note, task.progress); task.claim = null; task.assignee = null; touch(task); return json(serializeTask(task, true, tag)); }
  if (action === 'complete') { if (task.claim && task.claim.agentId !== input.agentId) return json({ error: 'only the current agent can complete' }, 403); task.status = 'done'; task.progress = 100; task.completedAt = now(); task.completedBy = String(input.agentId ?? 'human'); task.result = String(input.result ?? ''); record(task, 'completed', task.completedBy, task.result, 100); task.claim = null; touch(task); return json(serializeTask(task, true, tag)); }
  if (action === 'resources' && req.method === 'POST') { const resource = normalizeResources([{ ...input, addedBy: input.addedBy ?? input.actorId ?? 'human' }])[0]; if (!resource) return json({ error: 'resource requires kind, title and url' }, 400); task.resources.push(resource); record(task, 'updated', String(input.actorId ?? resource.addedBy), `added resource: ${resource.title}`); touch(task); return json(serializeTask(task, true, tag), 201); }
  if (action === 'resources' && req.method === 'DELETE') { const resourceId = decodeURIComponent(url.pathname.split('/')[5] ?? ''); const before = task.resources.length; task.resources = task.resources.filter((resource) => resource.id !== resourceId); if (task.resources.length === before) return json({ error: 'resource not found' }, 404); record(task, 'updated', String(input.actorId ?? 'human'), `removed resource: ${resourceId}`); touch(task); return json(serializeTask(task, true, tag)); }
  if (req.method === 'PATCH' && !action) {
    const parentTaskId = 'parentTaskId' in input ? normalizeParentId(input.parentTaskId) : task.parentTaskId;
    const parentErrorMessage = parentError(task.id, parentTaskId, tag);
    if (parentErrorMessage) return json({ error: parentErrorMessage }, 400);
    const resources = 'resources' in input ? normalizeResources(input.resources) : task.resources;
    if ('resources' in input && (!Array.isArray(input.resources) || resources.length !== input.resources.length)) return json({ error:'each resource requires kind, title and url' },400);
    const beforeBasis = verificationBasis(task); const wasDone = task.status === 'done';
    const allowed = ['title', 'description', 'status', 'priority', 'deadline', 'projectSlug', 'blockedReason', 'assignee', 'progress', 'result'];
    for (const key of allowed) if (key in input) (task as any)[key] = input[key];
    if ('tags' in input) task.tags = ensureTag(input.tags, tag); else if (tag) task.tags = ensureTag(task.tags, tag);
    if ('people' in input) task.people = normalizePeople(input.people);
    if ('parentTaskId' in input) task.parentTaskId = parentTaskId;
    task.resources = resources; task.acceptanceCriteria = acceptance.criteria;
    // A done row cannot retain completion after its acceptance is changed to pending/failed.
    if (task.status === 'done' && beforeBasis !== verificationBasis(task) && completionError(task.acceptanceCriteria)) {
      task.status = 'blocked'; task.blockedReason = '验收标准或结果已变化，需重新验收并完成任务';
    }
    if (task.status !== 'claimed') task.claim = null;
    record(task, 'updated', input.actorId ?? 'human', input.note);
    if (task.status === 'done' && (!wasDone || !task.completedAt)) { task.completedAt = now(); task.completedBy = String(input.actorId ?? 'human'); task.progress = 100; }
    touch(task); return json(serializeTask(task, true, tag));
  }
  return json({ error: 'unsupported operation' }, 405);
}

function reminderTick() {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const values = Object.fromEntries(local.map((p) => [p.type, p.value])); const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  if (values.hour === '10' && values.minute === '00' && lastReminderDate !== date) { lastReminderDate = date; const pending = tasks.filter((t) => !['done', 'cancelled'].includes(t.status)); const payload = { type: 'daily.reminder', date, count: pending.length, overdue: pending.filter((t) => t.deadline && Date.parse(t.deadline) < Date.now()).length, dueToday: pending.filter((t) => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length }; console.log(`[task-board] daily reminder ${JSON.stringify(payload)}`); broadcast(payload); }
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await flushPendingSave(); }
  catch (error) { console.error(`[task-board] failed to flush data during ${signal}`, error); process.exit(1); }
  process.exit(0);
}

await load(); setInterval(reminderTick, 30_000); setInterval(expireLeases, 60_000);
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(signal));
Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 0, fetch: async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/.well-known/forgeax-task-board' && req.method === 'GET') return discovery(url);
  if (url.pathname === '/agent-guide.md' && req.method === 'GET') return new Response(Bun.file(join(ROOT, 'public', 'agent-guide.md')), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
  if (url.pathname === '/api/login' && req.method === 'POST') return login(req);
  if (url.pathname === '/api/logout' && req.method === 'POST') return logout();
  if (url.pathname === '/login' && req.method === 'GET') {
    if (!authEnabled() || authorized(req)) return Response.redirect(new URL(scopedRoot(), url), 302);
    const file = Bun.file(join(ROOT, 'public', 'login.html'));
    return new Response(file, { headers: { 'cache-control': 'no-store' } });
  }
  if (!authorized(req)) return url.pathname.startsWith('/api/') ? unauthorized() : loginRedirect(url);
  if (REQUIRED_TAG && url.pathname === '/' && normalizeTag(url.searchParams.get('tag')) !== REQUIRED_TAG) { url.searchParams.set('tag', REQUIRED_TAG); return Response.redirect(url, 302); }
  if (url.pathname.startsWith('/api/')) return handler(req);
  const path = url.pathname === '/' ? '/index.html' : url.pathname; const file = Bun.file(join(ROOT, 'public', path)); return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
} });
console.log(`[task-board] running at http://${HOST}:${PORT} · timezone ${TZ} · scope ${REQUIRED_TAG || 'all'} · auth ${AUTH_USER && AUTH_PASSWORD ? 'enabled' : 'disabled'}`);
