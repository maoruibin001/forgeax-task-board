import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as selectors from '../public/board-selectors.js';

// Exercise the actual renderer with a minimal DOM sink. Fixtures never reach a board server.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const rendering = source.slice(source.indexOf('\n') + 1, source.indexOf('let refreshSequence'));
function board(tasks: any[]) {
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) {
      const classes = new Set<string>();
      nodes.set(selector, {
        value: '', innerHTML: '', textContent: '', style: {},
        selectedOptions: [{textContent:'TEST filter'}],
        classList: {
          add: (name: string) => classes.add(name),
          toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name),
          contains: (name: string) => classes.has(name),
        },
        setAttribute() {},
      });
    }
    return nodes.get(selector);
  };
  const document = {querySelector: node, querySelectorAll: () => [], title: ''};
  const context = {document, location: {search:''}, URLSearchParams, ...selectors};
  const render = runInNewContext(`${rendering}\n(tasks, filters = {}) => { state.tasks = tasks; state.available = true; state.sourceAt = '2026-10-26T06:00:00Z'; state.filter = 'all'; Object.assign(state, filters); render(); }`, context);
  render(tasks);
  return {node, render: (filters = {}) => render(tasks, filters)};
}
function task(id: string, status: string, extra: any = {}) {
  return {id, title:id, description:'TEST fixture', status, priority:'high', tags:[], people:[], resources:[], parentTaskId:null, updatedAt:'2026-10-26T05:00:00Z', ...extra};
}

test('only populated status sections render; searches and refresh restore original cards and verification', () => {
  const tasks = [task('test-inbox','inbox'), task('test-done','done',{verification:{status:'verified'}})];
  const before = structuredClone(tasks);
  const view = board(tasks);
  expect(view.node('#board').innerHTML.match(/class="column"/g)).toHaveLength(2);
  expect(view.node('#board').innerHTML).toContain('data-status="inbox"');
  expect(view.node('#board').innerHTML).not.toContain('data-status="claimed"');
  expect(view.node('#board').innerHTML).toContain('verification-verified');
  expect(view.node('#claims-panel').classList.contains('hidden')).toBe(true);
  expect(view.node('#ready-panel').classList.contains('hidden')).toBe(true);
  view.node('#search').value = 'test-done'; view.render();
  expect(view.node('#board').innerHTML.match(/class="column"/g)).toHaveLength(1);
  expect(view.node('#board').innerHTML).not.toContain('data-status="inbox"');
  view.node('#search').value = ''; view.render();
  expect(view.node('#board').innerHTML).toContain('data-id="test-inbox"');
  expect(tasks).toEqual(before);
});

test('no matches have one overall empty result; outside-filter queues retain compact access without empty cards', () => {
  const tasks = [task('test-parent','inbox'), task('test-child','ready',{parentTaskId:'test-parent'}), task('test-claim','claimed',{claim:{agentId:'test-agent',claimedAt:'2026-10-26T05:00:00Z',leaseUntil:'2026-10-26T07:00:00Z'}})];
  const view = board(tasks);
  view.node('#search').value = 'test-no-match'; view.render();
  expect(view.node('#board').innerHTML.match(/class="empty /g)).toHaveLength(1);
  expect(view.node('#board-heading').classList.contains('hidden')).toBe(true);
  for (const kind of ['ready','claims']) {
    expect(view.node(`#${kind}-panel`).classList.contains('hidden')).toBe(false);
    expect(view.node(`#${kind}-panel`).classList.contains('compact-panel')).toBe(true);
    expect(view.node(`#show-all-${kind}`).classList.contains('hidden')).toBe(false);
  }
  expect(view.node('#ready-tasks').innerHTML).toBe('');
  expect(view.node('#active-claims').innerHTML).toBe('');
});

test('child-only matches keep the original parent link and status count without inheriting its filter', () => {
  const view = board([task('test-parent','inbox'),task('test-child','ready',{parentTaskId:'test-parent'})]);
  view.node('#search').value = 'test-child'; view.render();
  expect(view.node('#board').innerHTML).toContain('data-id="test-parent"');
  expect(view.node('#board').innerHTML).toContain('关联主任务 · 本身不匹配筛选');
  expect(view.node('#board').innerHTML).toContain('<b>1</b>');
  expect(view.node('#ready-tasks').innerHTML).toContain('data-open-task="test-child"');
  expect(view.node('#ready-count').textContent).toBe(1);
});

test('every original business status remains displayable when populated, including cancelled filters', () => {
  const statuses = ['inbox','ready','claimed','blocked','done','cancelled'];
  const view = board(statuses.map(status => task('test-'+status,status)));
  expect(view.node('#board').innerHTML.match(/class="column"/g)).toHaveLength(6);
  for (const status of statuses) expect(view.node('#board').innerHTML).toContain(`data-status="${status}"`);
  view.render({metric:'cancelled'});
  expect(view.node('#board').innerHTML.match(/class="column"/g)).toHaveLength(1);
  expect(view.node('#board').innerHTML).toContain('data-id="test-cancelled"');
  expect(view.node('#board').innerHTML).not.toContain('board-empty');
});
