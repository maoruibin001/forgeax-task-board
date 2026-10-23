import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAcceptance, completionError } from '../acceptance';

const root = join(import.meta.dir, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'test-task-center-acceptance-'));
const probe = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('test')});
const port = probe.port!; probe.stop(true);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;
const pending = () => [{id:'visible-result',criterion:'Synthetic actual result must be visible',status:'pending',evidence:''}];
const passed = () => [{...pending()[0],status:'passed',evidence:'synthetic:test actual visible receipt'}];

async function request(path:string, method='GET', body?:unknown) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any};
}
async function create(criteria:unknown=pending()) { return (await request('/api/tasks','POST',{title:'TEST acceptance fixture',tags:['test=true'],status:'inbox',acceptanceCriteria:criteria})).data; }

beforeAll(async()=>{
  server=Bun.spawn([process.execPath,join(root,'server.ts')],{cwd:root,env:{...process.env,PORT:String(port),TASK_BOARD_HOST:'127.0.0.1',TASK_BOARD_DATA_DIR:dataDir,TASK_BOARD_AUTH_USER:'',TASK_BOARD_AUTH_PASSWORD:'',TASK_BOARD_REQUIRED_TAG:''},stdout:'ignore',stderr:'pipe'});
  for(let n=0;n<50;n++){try{if((await fetch(base+'/api/summary')).ok)return;}catch{}await Bun.sleep(20);}
  throw Error('Synthetic test source failed to start');
});
afterAll(async()=>{server?.kill('SIGTERM');await server?.exited;await rm(dataDir,{recursive:true,force:true});});

test('acceptance schema rejects malformed, duplicate or oversized criteria',()=>{
  expect(parseAcceptance([{...pending()[0],status:'probably'}]).error).toBeDefined();
  expect(parseAcceptance([...pending(),...pending()]).error).toBeDefined();
  expect(parseAcceptance(Array(41).fill(pending()[0])).error).toBeDefined();
  expect(completionError(parseAcceptance(pending()).criteria)).toContain('验收');
  expect(completionError(parseAcceptance(passed()).criteria)).toBeNull();
});
test('pending/failed and missing evidence cannot complete; original status/history survive',async()=>{
  const task=await create();
  const blocked=await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:'test',result:'TEST implementation only'});
  expect(blocked.status).toBe(409);
  const reread=(await request('/api/tasks/'+task.id)).data;
  expect(reread.status).toBe('inbox'); expect(reread.history).toEqual(task.history);
  expect((await request('/api/tasks/'+task.id,'PATCH',{status:'done',result:'TEST done'})).status).toBe(409);
  expect((await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:[{...pending()[0],status:'failed',evidence:'TEST actual failure'}]})).status).toBe(200);
  expect((await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:'test',result:'TEST failed'})).status).toBe(409);
  await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:[{...passed()[0],evidence:''}]});
  expect((await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:'test',result:'TEST no evidence'})).status).toBe(409);
});
test('new done and removing standards cannot bypass the same API gate',async()=>{
  expect((await request('/api/tasks','POST',{title:'TEST premature done',status:'done',acceptanceCriteria:pending()})).status).toBe(409);
  const task=await create();
  expect((await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:[],status:'done'})).status).toBe(409);
  expect((await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:[]})).status).toBe(409);
  expect((await request('/api/tasks/'+task.id)).data.acceptanceCriteria).toEqual(pending());
});
test('passing all criteria allows normal complete with result, without claiming another task',async()=>{
  const task=await create();
  expect((await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:passed()})).status).toBe(200);
  expect((await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:'test'})).status).toBe(409);
  const done=await request(`/api/tasks/${task.id}/complete`,'POST',{agentId:'test',result:'TEST all actual acceptance criteria passed'});
  expect(done.status).toBe(200); expect(done.data.status).toBe('done'); expect(done.data.claim).toBeNull();
  expect(done.data.acceptanceCriteria).toEqual(passed());
});
test('editing a passed standard invalidates old evidence and blocks same-save done',async()=>{
  const task=await create(passed());
  const changed=[{...passed()[0],criterion:'Synthetic changed requirement'}];
  expect((await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:changed,status:'done',result:'TEST outdated receipt'})).status).toBe(409);
  const saved=await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:changed});
  expect(saved.data.acceptanceCriteria[0].status).toBe('pending'); expect(saved.data.acceptanceCriteria[0].evidence).toBe('');
});
test('official guide and ordinary editor disclose criteria, evidence and blocked handoff',async()=>{
  const guide=await request('/api/agent-guide'); expect(guide.data.completion.rule).toContain('逐项');
  const html=await (await fetch(base+'/')).text(); expect(html).toContain('id="acceptance-items"'); expect(html).toContain('未通过先标记受阻');
  const js=await (await fetch(base+'/app.js')).text(); expect(js).toContain('acceptancePanel(task)'); expect(js).toContain('不能标记完成');
});
test('legacy tasks with no structured standards remain readable without fabricated acceptance',async()=>{
  const task=await create([]); expect(task.acceptanceCriteria).toEqual([]);
  expect((await request('/api/tasks/'+task.id)).data.acceptanceCriteria).toEqual([]);
});
