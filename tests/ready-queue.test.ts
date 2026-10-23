import { expect, test } from 'bun:test';
import { directionNote, hasReadyConflict, readyChildQueue } from '../public/board-selectors.js';

const parent = {id:'test-direction', parentTaskId:null, status:'inbox', claim:null, history:[{type:'created'}]};
const child = {id:'test-ready', parentTaskId:parent.id, status:'ready', blockedReason:'', tags:['child-only'], people:['Alice'], priority:'low', description:'前置：TEST predecessor 未完成；先核对原验收。'};

test('child-only matches enter the ready queue without inheriting parent filters or changing the direction', () => {
  const elsewhere = {...child, id:'test-other-direction', parentTaskId:'test-out-of-scope-parent'};
  const tasks = [parent, child, elsewhere];
  const before = structuredClone(tasks);
  const queue = readyChildQueue(tasks, [child]);
  expect(queue.selected.map(task=>task.id)).toEqual([child.id]);
  expect(queue.globalCount).toBe(2); expect(queue.outsideCount).toBe(1);
  expect(queue.selected[0].description).toBe(child.description);
  expect(tasks).toEqual(before);
  expect(directionNote(parent, tasks)).toContain('已拆解 1 项子任务');
  expect(parent.status).toBe('inbox'); expect(parent.claim).toBeNull();
});

test('inbox, blocked, claimed, done and cancelled children and ready parents do not inflate ready children', () => {
  const tasks = [parent, child, {...parent,id:'test-ready-parent',status:'ready'}, ...['inbox','blocked','claimed','done','cancelled'].map(status=>({...child,id:'test-'+status,status}))];
  expect(readyChildQueue(tasks, tasks).selected.map(task=>task.id)).toEqual([child.id]);
  expect(readyChildQueue(tasks, []).globalCount).toBe(1);
  expect(readyChildQueue(tasks, []).outsideCount).toBe(1);
  expect(directionNote({...parent,id:'test-empty-direction'}, tasks)).toContain('尚无子任务');
  expect(directionNote(child, tasks)).toBe('');
});

test('ready plus blockedReason remains visible as a conflict, never silently cleared or guaranteed executable', () => {
  const conflict = {...child,id:'test-conflict',blockedReason:'TEST：等待本人真实身份验收'};
  const before = structuredClone(conflict);
  const queue = readyChildQueue([parent, child, conflict], [child, conflict]);
  expect(queue.selected).toHaveLength(2); expect(queue.conflictCount).toBe(1);
  expect(hasReadyConflict(conflict)).toBe(true);
  expect(hasReadyConflict({...conflict,status:'blocked'})).toBe(false);
  expect(hasReadyConflict({...child,blockedReason:'  '})).toBe(false);
  expect(conflict).toEqual(before);
});
