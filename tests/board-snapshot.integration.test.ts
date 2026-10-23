import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'test-board-child-snapshot-'));
const probe = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('test')});
const port = probe.port!; probe.stop(true);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;
const worker = {agentId:'test-worker',agentName:'TEST 执行者',sessionId:'test-session',process:'test',cwd:'/test'};
async function request(path:string, method='GET', body?:unknown) {
  const res = await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await res.json() as any;
  expect(res.ok).toBe(true); return data;
}
async function snapshot() { return request('/api/board'); }
async function create(title:string, extra:Record<string,unknown>={}) {
  return request('/api/tasks','POST',{title,tags:['test=true'],...extra});
}
beforeAll(async()=>{
  await writeFile(join(dataDir,'tasks.json'), JSON.stringify([{id:'test-expired-legacy',title:'TEST legacy expired claim',status:'claimed',priority:'normal',tags:['test=true'],people:[],description:'',deadline:null,projectSlug:'',parentTaskId:null,resources:[],history:[],createdAt:'2000-01-01T00:00:00Z',updatedAt:'2000-01-01T00:00:00Z',claim:{agentId:'test-old-agent',claimedAt:'2000-01-01T00:00:00Z',leaseUntil:'2000-01-01T00:01:00Z'}}]));
  server = Bun.spawn([process.execPath,join(root,'server.ts')],{cwd:root,env:{...process.env,PORT:String(port),TASK_BOARD_HOST:'127.0.0.1',TASK_BOARD_DATA_DIR:dataDir,TASK_BOARD_AUTH_USER:'',TASK_BOARD_AUTH_PASSWORD:'',TASK_BOARD_REQUIRED_TAG:''},stdout:'ignore',stderr:'pipe'});
  for (let n=0;n<50;n++) { try { if ((await fetch(base+'/api/summary')).ok) return; } catch {} await Bun.sleep(20); }
  throw Error('test board did not start');
});
afterAll(async()=>{server?.kill('SIGTERM');await server?.exited;await rm(dataDir,{recursive:true,force:true});});

test('inbox parent stays unchanged while cross-priority children carry real claim/report and original IDs',async()=>{
  const parent = await create('TEST parent inbox',{status:'inbox',priority:'high',tags:['test=true','P0'],people:['Parent person']});
  const child = await create('TEST child normal',{parentTaskId:parent.id,priority:'normal',people:['Child person']});
  const low = await create('TEST child low',{parentTaskId:parent.id,priority:'low',tags:['test=true','child-only']});
  const before = await request('/api/tasks/'+parent.id);
  await request(`/api/tasks/${child.id}/claim`,'POST',worker);
  let board = await snapshot();
  expect(board.sourceAt).toBeTruthy(); expect(board.requiredTag).toBeNull();
  expect(board.tasks.find((t:any)=>t.id===child.id).latestReport).toBeNull();
  await request(`/api/tasks/${child.id}/progress`,'POST',{agentId:worker.agentId,progress:37,note:'TEST actual report'});
  await request(`/api/tasks/${child.id}/renew`,'POST',{agentId:worker.agentId,note:'TEST renewal is not progress'});
  board = await snapshot();
  const projected = board.tasks.find((t:any)=>t.id===child.id);
  expect(projected.claim.agentId).toBe(worker.agentId); expect(projected.parentTaskId).toBe(parent.id);
  expect(projected.people).toEqual(['Child person']); expect(projected.priority).toBe('normal');
  expect(projected.latestReport.note).toBe('TEST actual report'); expect(projected.latestReport.progress).toBe(37);
  expect(projected.history).toBeUndefined();
  expect(board.tasks.find((t:any)=>t.id===parent.id).subtaskCount).toBe(2);
  const after = await request('/api/tasks/'+parent.id);
  expect(after.status).toBe('inbox'); expect(after.claim).toBeNull(); expect(after.history).toEqual(before.history);
  expect((await request('/api/tasks?tag=child-only')).map((t:any)=>t.id)).toEqual([low.id]);
  expect((await request('/api/tasks?person=child%20person')).map((t:any)=>t.id)).toEqual([child.id]);
});

test('blocked, release, re-claim and completion are distinct; old progress never becomes a fresh report',async()=>{
  const task = await create('TEST lifecycle');
  await request(`/api/tasks/${task.id}/claim`,'POST',worker);
  await request(`/api/tasks/${task.id}/progress`,'POST',{agentId:worker.agentId,progress:23,status:'blocked',note:'TEST blocked for input'});
  let row = (await snapshot()).tasks.find((t:any)=>t.id===task.id);
  expect(row.status).toBe('blocked'); expect(row.latestReport.type).toBe('blocked'); expect(row.blockedReason).toBe('TEST blocked for input');
  await request(`/api/tasks/${task.id}/release`,'POST',{agentId:worker.agentId,note:'TEST handoff'});
  row = (await snapshot()).tasks.find((t:any)=>t.id===task.id);
  expect(row.status).toBe('ready'); expect(row.claim).toBeNull(); expect(row.latestReport.type).toBe('released');
  await request(`/api/tasks/${task.id}/claim`,'POST',worker);
  row = (await snapshot()).tasks.find((t:any)=>t.id===task.id);
  expect(row.latestReport).toBeNull(); expect(row.progress).toBe(23);
  expect((await request('/api/tasks/'+task.id)).latestReport).toBeNull();
  await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:worker.agentId,result:'TEST observed completion'});
  row = (await snapshot()).tasks.find((t:any)=>t.id===task.id);
  expect(row.status).toBe('done'); expect(row.claim).toBeNull(); expect(row.latestReport.type).toBe('completed');
  expect(row.latestReport.note).toBe('TEST observed completion');
});

test('snapshot is read-only and no-store; UI and guide disclose the scope and unavailable state',async()=>{
  const tasksBefore = await request('/api/tasks');
  const response = await fetch(base+'/api/board');
  expect(response.headers.get('cache-control')).toBe('no-store'); await response.json();
  expect(await request('/api/tasks')).toEqual(tasksBefore);
  const guide = await request('/api/agent-guide'); expect(guide.taskQueries.boardSnapshot).toBe('/api/board');
  const html = await (await fetch(base+'/')).text(); expect(html).toContain('id="active-claims"'); expect(html).toContain('id="data-status"');
});

test('legacy expired lease appears as ready with expiration history, never a live claim', async()=>{
  const row = (await snapshot()).tasks.find((task:any)=>task.id==='test-expired-legacy');
  expect(row.status).toBe('ready'); expect(row.claim).toBeNull();
  expect(row.latestReport.type).toBe('lease_expired');
});
