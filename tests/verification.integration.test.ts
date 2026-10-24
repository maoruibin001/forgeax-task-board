import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTestTask, isArchivedTask, taskMetrics, metricMatch } from '../public/board-selectors.js';

const root = join(import.meta.dir,'..');
const dataDir = await mkdtemp(join(tmpdir(),'test-task-verification-'));
const probe = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('test')});
const port = probe.port!; probe.stop(true); const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;
const criteria = [{id:'visible',criterion:'TEST visible delivery',status:'passed',evidence:'TEST observed artifact receipt'}];
const worker = {agentId:'test-worker',sessionId:'test-session',process:'test',cwd:'/test'};
async function request(path:string,method='GET',body?:unknown) {
  const res = await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json() as any};
}
async function create(extra={}) { const r = await request('/api/tasks','POST',{title:'TEST verification fixture',test:true,status:'done',acceptanceCriteria:criteria,result:'TEST actual delivered result',...extra}); expect(r.status).toBe(201); return r.data; }
async function read(id:string) { return (await request('/api/tasks/'+id)).data; }
async function review(task:any,status='verified',extra={}) { return request(`/api/tasks/${task.id}/verification`,'POST',{status,reviewer:'TEST independent reviewer',evidence:'TEST actual review receipt',expectedBasis:task.verificationBasis,...extra}); }
beforeAll(async()=>{
  await writeFile(join(dataDir,'tasks.json'),JSON.stringify([{id:'test-legacy-done',title:'TEST legacy done',description:'',status:'done',priority:'normal',tags:['test=true'],people:[],projectSlug:'',resources:[],parentTaskId:null,result:'TEST historical result',acceptanceCriteria:criteria,history:[{id:'old-review',type:'updated',at:'2020-01-01T00:00:00Z',actor:'TEST historical supervisor',note:'TEST historical review passed'}],createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'}]));
  server = Bun.spawn([process.execPath,join(root,'server.ts')],{cwd:root,env:{...process.env,PORT:String(port),TASK_BOARD_HOST:'127.0.0.1',TASK_BOARD_DATA_DIR:dataDir,TASK_BOARD_AUTH_USER:'',TASK_BOARD_AUTH_PASSWORD:'',TASK_BOARD_REQUIRED_TAG:''},stdout:'ignore',stderr:'pipe'});
  for(let n=0;n<50;n++) { try { if((await fetch(base+'/api/summary')).ok)return; } catch {} await Bun.sleep(20); }
  throw Error('TEST source did not start');
});
afterAll(async()=>{server?.kill('SIGTERM');await server?.exited;await rm(dataDir,{recursive:true,force:true});});

test('legacy done preserves historical acceptance without fabricating the new verification phase',async()=>{
  const before=await read('test-legacy-done'); expect(before.status).toBe('done'); expect(before.verification.status).toBe('pending');
  expect(before.acceptanceCriteria).toEqual(criteria); expect(before.history[0].id).toBe('old-review'); expect(before.verification.at).toBeNull();
  const snap=(await request('/api/board')).data; const metrics=taskMetrics(snap.tasks,Date.parse(snap.sourceAt));
  expect(metrics.done).toBe(1); expect(metrics.verified).toBe(0);
  expect((await read(before.id)).history).toEqual(before.history);
});
test('normal completion then explicit verification records actor, time, basis, evidence and immutable history',async()=>{
  const task=await create({status:'ready'}); expect((await review(task)).status).toBe(409);
  const done=(await request(`/api/tasks/${task.id}/complete`,'POST',{result:task.result})).data;
  const verified=await review(done); expect(verified.status).toBe(200); expect(verified.data.status).toBe('done');
  expect(verified.data.verification).toMatchObject({status:'verified',reviewer:'TEST independent reviewer',evidence:'TEST actual review receipt',basis:done.verificationBasis});
  expect(Date.parse(verified.data.verification.at)).toBeGreaterThan(0);
  const event=verified.data.history.at(-1); expect(event.type).toBe('verification_recorded'); expect(event.verification).toEqual(verified.data.verification);
  const row=(await request('/api/board')).data.tasks.find((t:any)=>t.id===task.id); expect(row.verification).toEqual(verified.data.verification);
});
test('verification gates reject missing reviewer/evidence, stale review and direct PATCH/create injection atomically',async()=>{
  const task=await create();
  for(const extra of [{reviewer:''},{evidence:''},{expectedBasis:'stale'},{status:'imaginary'}]) expect((await review(task,'verified',extra)).status).toBe(409);
  expect((await request('/api/tasks/'+task.id,'PATCH',{verification:{status:'verified'}})).status).toBe(400);
  expect((await request('/api/tasks','POST',{title:'TEST injection',verification:{status:'verified'}})).status).toBe(400);
  expect((await request(`/api/tasks/${task.id}/verification`,'DELETE')).status).toBe(405);
  expect((await request(`/api/tasks/${task.id}/verification`,'PATCH',{status:'done'})).status).toBe(405);
  expect(await read(task.id)).toEqual(task);
});
test('legacy without criteria cannot verify; pending/failed/no evidence cannot bypass completion',async()=>{
  const legacy=await create({acceptanceCriteria:[]}); expect((await review(legacy)).status).toBe(409);
  for(const criterion of [{...criteria[0],status:'pending'},{...criteria[0],status:'failed'},{...criteria[0],evidence:''}]) {
    const task=await create({status:'ready',acceptanceCriteria:[criterion]});
    expect((await request('/api/tasks/'+task.id,'PATCH',{status:'done',result:'TEST result'})).status).toBe(409);
    expect((await review(task)).status).toBe(409);
  }
});
test('failed/insufficient/reset results leave completion history and never count as verification complete',async()=>{
  let task=(await review(await create())).data; const first=task.verification;
  for(const status of ['failed','insufficient','pending']) {
    const result=await review(task,status); expect(result.status).toBe(200); task=result.data;
    expect(task.status).toBe('done'); expect(task.verification.status).toBe(status); expect(taskMetrics([task],Date.now()).verified).toBe(0);
  }
  expect(task.history.find((e:any)=>e.verification?.status==='verified').verification).toEqual(first);
  expect(task.history.filter((e:any)=>e.type==='verification_recorded')).toHaveLength(4);
});
test('descriptive, title, personnel, priority, resource and tag edits keep valid verification',async()=>{
  const task=(await review(await create())).data;
  const updated=(await request('/api/tasks/'+task.id,'PATCH',{title:'TEST renamed',description:'TEST explanation only',priority:'low',tags:['TEST=true','other'],people:['Alice']})).data;
  expect(updated.verification).toEqual(task.verification); expect(updated.verificationBasis).toBe(task.verificationBasis);
  const resource=(await request(`/api/tasks/${task.id}/resources`,'POST',{kind:'acceptance_artifact',title:'TEST link',url:'/test-artifact'})).data;
  expect(resource.verification).toEqual(task.verification);
});
test('criterion reorder and lease renewal attempts do not invalidate a completed review; tag scope remains enforced',async()=>{
  const task=(await review(await create({tags:['test=true','scope-a'],acceptanceCriteria:[...criteria,{...criteria[0],id:'second'}]}))).data;
  const reordered=(await request('/api/tasks/'+task.id,'PATCH',{acceptanceCriteria:[...task.acceptanceCriteria].reverse()})).data;
  expect(reordered.verification).toEqual(task.verification); expect(reordered.verificationBasis).toBe(task.verificationBasis);
  expect((await request(`/api/tasks/${task.id}/renew`,'POST',worker)).status).toBe(403);
  expect((await request(`/api/tasks/${task.id}/verification?tag=scope-b`,'POST',{status:'verified',reviewer:'TEST',evidence:'TEST',expectedBasis:reordered.verificationBasis})).status).toBe(404);
  expect((await read(task.id)).verification).toEqual(task.verification);
});
test('changed standards invalidate verification, reset evidence and require normal re-acceptance/completion',async()=>{
  const verified=(await review(await create())).data;
  const changed=(await request('/api/tasks/'+verified.id,'PATCH',{acceptanceCriteria:[{...criteria[0],criterion:'TEST changed requirement'}]})).data;
  expect(changed.status).toBe('blocked'); expect(changed.verification.status).toBe('invalidated'); expect(changed.verification.invalidatedAt).toBeTruthy();
  expect(changed.acceptanceCriteria[0]).toMatchObject({status:'pending',evidence:''});
  expect(changed.history.some((e:any)=>e.type==='verification_invalidated')).toBe(true);
  expect((await review(changed)).status).toBe(409);
  const accepted=(await request('/api/tasks/'+changed.id,'PATCH',{acceptanceCriteria:[{...changed.acceptanceCriteria[0],status:'passed',evidence:'TEST new receipt'}]})).data;
  const done=(await request(`/api/tasks/${changed.id}/complete`,'POST',{result:'TEST new delivery'})).data;
  expect(done.status).toBe('done'); expect((await review(done)).status).toBe(200); expect(accepted.status).toBe('blocked');
});
test('new acceptance items, changed delivery and reopened status invalidate; stale verification is rejected',async()=>{
  for(const patch of [{acceptanceCriteria:[...criteria,{id:'added',criterion:'TEST new criterion',status:'passed',evidence:'TEST added receipt'}]},{result:'TEST changed delivery'},{status:'ready'}]) {
    const task=(await review(await create())).data;
    const result=await request('/api/tasks/'+task.id,'PATCH',patch); expect(result.status).toBe(200); expect(result.data.verification.status).toBe('invalidated');
    expect((await review(task)).status).toBe(409);
  }
  const task=(await review(await create())).data;
  const recompleted=(await request(`/api/tasks/${task.id}/complete`,'POST',{result:'TEST re-complete different delivery'})).data;
  expect(recompleted.verification.status).toBe('invalidated'); expect(recompleted.history.at(-1).type).toBe('verification_invalidated');
});
test('claim, renew, report, block, release and complete project counts without claiming the parent container',async()=>{
  const parent=await create({status:'inbox'}); const child=await create({status:'ready',parentTaskId:parent.id});
  const metrics=async()=>{const snap=(await request('/api/board')).data;return taskMetrics(snap.tasks.filter((t:any)=>[parent.id,child.id].includes(t.id)),Date.parse(snap.sourceAt));};
  await request(`/api/tasks/${child.id}/claim`,'POST',worker); let m=await metrics(); expect(m).toMatchObject({total:2,main:1,child:1,claimed:1,reported:0,unknown:1});
  await request(`/api/tasks/${child.id}/renew`,'POST',worker); expect((await metrics()).unknown).toBe(1);
  await request(`/api/tasks/${child.id}/progress`,'POST',{agentId:worker.agentId,progress:30,note:'TEST actual report'}); expect((await metrics()).reported).toBe(1);
  await request(`/api/tasks/${child.id}/progress`,'POST',{agentId:worker.agentId,progress:30,status:'blocked',note:'TEST unavailable dependency'}); expect((await metrics()).claimed).toBe(0);
  await request(`/api/tasks/${child.id}/release`,'POST',worker); expect((await metrics()).claimed).toBe(0);
  await request(`/api/tasks/${child.id}/claim`,'POST',worker); expect((await metrics()).unknown).toBe(1);
  await request(`/api/tasks/${child.id}/complete`,'POST',{agentId:worker.agentId,result:'TEST completed'}); m=await metrics(); expect(m.done).toBe(1); expect(m.claimed).toBe(0); expect(m.verified).toBe(0);
  const p=await read(parent.id); expect(p.status).toBe('inbox'); expect(p.claim).toBeNull(); expect(p.history).toEqual(parent.history);
});
test('metrics handle empty, expired, stale reports, test exclusion, main/child and verification filters without double counting',()=>{
  const at=Date.now(); const claimed={id:'c',status:'claimed',parentTaskId:'p',claim:{agentId:'w',claimedAt:new Date(at-1000).toISOString(),leaseUntil:new Date(at+1000).toISOString()}};
  const tasks=[{id:'p',status:'inbox'},claimed,{...claimed,id:'expired',claim:{...claimed.claim,leaseUntil:new Date(at-1).toISOString()}},{...claimed,id:'old-report',latestReport:{type:'progress',actor:'w',at:new Date(at-2000).toISOString(),progress:99}},{id:'done',status:'done'},{id:'verified',parentTaskId:'p',status:'done',verification:{status:'verified'}},{id:'not-done',status:'blocked',verification:{status:'verified'}}];
  expect(taskMetrics(tasks,at)).toMatchObject({total:7,done:2,verified:1,claimed:2,reported:0,unknown:2,main:3,child:4});
  expect(taskMetrics([],at)).toMatchObject({total:0,done:0,verified:0,unknown:0});
  expect(tasks.filter(t=>metricMatch(t,'verified',at)).map(t=>t.id)).toEqual(['verified']);
  expect(tasks.filter(t=>metricMatch(t,'claimed',at)).map(t=>t.id)).toEqual(['c','old-report']);
  expect(isArchivedTask({tags:['archived-20261021']})).toBe(true); expect(isArchivedTask({status:'cancelled',tags:[]})).toBe(false); expect(isArchivedTask({tags:['archived-someday']})).toBe(false);
  expect(isTestTask({test:true})).toBe(true); expect(isTestTask({tags:['TEST=true']})).toBe(true); expect(isTestTask({tags:['contest=true']})).toBe(false);
});


test('test and archived scopes are explicit subsets of one snapshot and do not mutate historical rows',async()=>{
  const archived=await create({tags:['test=true','archived-20261021']});
  const ordinary=await create(); const snap=(await request('/api/board')).data;
  const selected=snap.tasks.filter((t:any)=>!isArchivedTask(t));
  expect(selected.some((t:any)=>t.id===archived.id)).toBe(false); expect(selected.some((t:any)=>t.id===ordinary.id)).toBe(true);
  expect(snap.tasks.some((t:any)=>t.id===archived.id)).toBe(true);
  expect(taskMetrics(selected,Date.parse(snap.sourceAt)).total).toBe(snap.tasks.length-1);
  expect(snap.tasks.filter((t:any)=>!isTestTask(t))).toHaveLength(0);
  expect(await read(archived.id)).toEqual(archived);
});
