import { readyChildQueue, hasReadyConflict, directionNote, isTestTask, isArchivedTask, validClaim, verifiedTask, metricMatch, taskMetrics } from './board-selectors.js';

const acceptanceLabels = {pending:'待验收',passed:'已通过',failed:'未通过'};
function acceptanceEditor(items=[]) { $('#acceptance-items').innerHTML=''; items.forEach(appendAcceptance); }
function appendAcceptance(item={id:crypto.randomUUID(),criterion:'',status:'pending',evidence:''}) { const row=document.createElement('div'); row.dataset.acceptanceId=item.id; row.innerHTML=`<label>验收标准<input data-criterion maxlength="500" required value="${esc(item.criterion)}"></label><div class="form-grid"><label>验收结果<select data-acceptance-status>${Object.entries(acceptanceLabels).map(([key,label])=>`<option value="${key}" ${key===item.status?'selected':''}>${label}</option>`).join('')}</select></label><label>实际证据<input data-acceptance-evidence maxlength="2000" value="${esc(item.evidence)}" placeholder="实际结果、报告或截图入口"></label></div>`; $('#acceptance-items').append(row); }
function acceptanceInput() { return [...document.querySelectorAll('[data-acceptance-id]')].map(row=>({id:row.dataset.acceptanceId,criterion:row.querySelector('[data-criterion]').value.trim(),status:row.querySelector('[data-acceptance-status]').value,evidence:row.querySelector('[data-acceptance-evidence]').value.trim()})); }
function acceptancePanel(task) { return task.acceptanceCriteria?.length?`<section class="detail-card"><div class="section-kicker">逐项验收 · 通过才完成</div>${task.acceptanceCriteria.map(item=>`<p><strong>${esc(acceptanceLabels[item.status]||'待核对')} · ${esc(item.criterion)}</strong><br>${esc(item.evidence||'尚无实际验收证据')}</p>`).join('')}<small>未验收或未通过时先标记受阻，交个人分身核查。记录通过仍需核对引用证据。</small></section>`:''; }
const initialTag = new URLSearchParams(location.search).get('tag')?.trim().toLowerCase() || '';
const initialPerson = new URLSearchParams(location.search).get('person')?.trim().toLowerCase() || '';
const state = { tasks: [], recent: [], tags: [], people: [], currentTask: null, filter: initialTag ? 'all' : 'p0p1', view: 'board', scopeTag: initialTag, scopePerson: initialPerson, sourceAt: null, available: false, error: '', requiredTag: '', readyExpanded: false, includeTests: false, includeArchives: false, metric: '' };
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
const safeHref = (value) => /^(javascript|data|vbscript):/i.test(String(value ?? '').trim()) ? '#' : esc(value);
const labels = { inbox:'待推进', ready:'可领取', claimed:'已领取', blocked:'已阻塞', done:'已完成', cancelled:'已取消' };
const priorities = { urgent:'紧急', high:'高', normal:'普通', low:'低' };
const columns = ['inbox','ready','claimed','blocked','done','cancelled'];
const resourceKinds = { requirement:'需求文档', bug:'Bug 单', acceptance_doc:'验收文档', acceptance_artifact:'验收产物' };
const verificationLabels = {pending:'验证未登记',verified:'验证完成',failed:'验证不通过',insufficient:'证据不足',invalidated:'验证已失效'};
function verificationBadge(task) { const status = task.verification?.status || 'pending'; return `<span class="verification-badge verification-${esc(status)}">${esc(verificationLabels[status] || '验证状态未知')}</span>`; }
function verificationPanel(task) {
  const v = task.verification || {status:'pending'};
  return `<section class="detail-card verification-panel"><div class="section-heading"><h3>交付后的验证</h3>${verificationBadge(task)}</div><p>已完成与验证完成分别记录。验证完成须先满足原逐项验收门槛，再核对实际结果并留下证据；旧 done 不自动登记新阶段；保留历史逐项验收事实。</p>${v.at ? `<div class="verification-record"><strong>${esc(v.reviewer)} · ${formatDate(v.at)}</strong><p>${esc(v.evidence)}</p>${v.reason ? `<p class="danger-text">${esc(v.reason)}${v.invalidatedAt ? ` · ${formatDate(v.invalidatedAt)}` : ''}</p>` : ''}<small>以上为署名验证记录，证据仍需审阅；历史保留历次结果。</small></div>` : '<p>未记录独立验证阶段；已有逐项验收与历史记录仍保留。</p>'}<form id="verification-form" class="verification-form"><input type="hidden" name="basis" value="${esc(task.verificationBasis)}"><div class="form-grid"><label>验证结论<select name="status"><option value="verified">验证完成</option><option value="failed">验证不通过</option><option value="insufficient">证据不足</option><option value="pending">退回验证未登记</option></select></label><label>验证人<input name="reviewer" required maxlength="200" placeholder="填写实际核对人或执行方署名"></label></div><label>实际证据 / 原因<textarea name="evidence" required maxlength="4000" rows="3" placeholder="填写实际验证结果、报告/截图入口；失败或不足时说明缺口"></textarea></label><small>${task.status === 'done' ? '验证不通过或证据不足时，保留完成历史并移出验证完成数；需要返工可用上方编辑改为已阻塞。' : '当前尚未完成：先逐项验收并正常完成任务；可退回验证未登记。'} 更改交付结果或验收依据会使旧验证失效；一般说明、标签和续租更新不影响验证。</small><p id="verification-feedback" role="status"></p><button class="primary" type="submit">保存验证记录</button></form></section>`;
}
async function submitVerification(e) {
  e.preventDefault(); const form = e.currentTarget; const fields = new FormData(form);
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    state.currentTask = await api(`/api/tasks/${state.currentTask.id}/verification`, {method:'POST', body:JSON.stringify({status:fields.get('status'),reviewer:fields.get('reviewer'),evidence:fields.get('evidence'),expectedBasis:fields.get('basis')})});
    await refresh(); toast('验证记录已保存', verificationLabels[state.currentTask.verification.status]);
  } catch (error) { const feedback = document.querySelector('#verification-feedback'); if (feedback) { feedback.className = 'danger-text'; feedback.textContent = error.message; } }
  finally { button.disabled = false; }
}
function renderProgressOverview(list) {
  const at = Date.parse(state.sourceAt); const global = population();
  const m = taskMetrics(list, at); const g = taskMetrics(global, at);
  const ratio = count => m.total ? `${(100 * count / m.total).toFixed(1)}%` : '0.0%';
  const metrics = [['total','任务总数',m.total],['done','已完成',m.done],['claimed','有效领取',m.claimed],['verified','验证完成 · 新阶段',m.verified]];
  $('#progress-overview').innerHTML = `<div class="overview-heading"><div><div class="eyebrow">PROGRESS / 当前筛选</div><h2>任务进度概览</h2></div><small>来源 ${formatDate(state.sourceAt)}</small></div><div class="overview-grid"><div class="completion-donut" style="--completion:${m.total ? m.done/m.total*100 : 0}%" role="img" aria-label="已完成 ${m.done} / ${m.total}，${ratio(m.done)}"><div><strong>${ratio(m.done)}</strong><span>完成比例</span></div></div><div class="overview-metrics">${metrics.map(([key,label,value])=>`<div class="overview-metric metric-${key}" data-metric="${key}"><span>${label}</span><strong>${value}</strong><div class="metric-track" aria-hidden="true"><i style="width:${m.total ? value/m.total*100 : 0}%"></i></div><small>${key === 'total' ? `主 ${m.main} / 子 ${m.child}` : `${ratio(value)} · 占当前总数`}</small></div>`).join('')}</div></div><p class="overview-execution">有效领取 ${m.claimed} 项中：本轮已报告进展 ${m.reported} 项 · 尚无本轮报告 ${m.unknown} 项。租约和进展报告均不代表进程此刻正在运行。</p><div class="overview-global">全局（${state.requiredTag ? `实例 #${esc(state.requiredTag)}` : '当前实例授权范围'}）：共 ${g.total} · 已完成 ${g.done} · 有效领取 ${g.claimed} · 验证完成 ${g.verified}（主 ${g.main} / 子 ${g.child}）</div><small class="overview-footnote">主、子任务各计一项；容器按自身状态计数。验证完成是已完成的子集，不能相加。仅统计当前任务库；历史归档${state.includeArchives ? '已包含' : `已排除 ${state.tasks.filter(isArchivedTask).length} 项`}（按归档标签识别）；测试任务${state.includeTests ? '已包含' : `已排除 ${state.tasks.filter(isTestTask).length} 项`}。</small><details class="metric-details"><summary>查看统计口径与任务明细（${list.length} 项）</summary><p>当前筛选同时使用标签、人员、优先级、搜索、日期及验证阶段；各条件按任务自身字段匹配。全局忽略这些筛选，沿用相同测试/归档开关和实例授权范围。有效领取以本次快照时间的未过期租约为准。原 status 保留，验证阶段单独列出。</p><div class="metrics-table-wrap"><table><caption>当前筛选 · 来源 ${formatDate(state.sourceAt)}</caption><thead><tr><th>原任务</th><th>类型</th><th>原状态</th><th>验证阶段</th><th>本轮报告</th></tr></thead><tbody>${list.length ? list.map(t=>`<tr><td><button class="inline-task-link" data-open-task="${esc(t.id)}">${esc(t.title)}</button><small>${esc(t.id)}</small></td><td>${t.parentTaskId ? '子任务' : '主任务'}</td><td>${esc(labels[t.status] || t.status)}</td><td>${verificationBadge(t)}</td><td>${isClaimed(t) ? (t.latestReport?.type === 'progress' ? `已报告 ${t.latestReport.progress ?? '未知'}%` : '尚无本轮报告') : '无有效领取'}</td></tr>`).join('') : '<tr><td colspan="5">当前筛选没有任务</td></tr>'}</tbody></table></div></details>`;
}

async function api(path, options) { const res = await fetch(path, { cache:'no-store', signal:AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data; }
function scopedPath(path, includePerson = true) { const url = new URL(path, location.origin); if (state.scopeTag) url.searchParams.set('tag', state.scopeTag); if (includePerson && state.scopePerson) url.searchParams.set('person', state.scopePerson); return `${url.pathname}${url.search}${url.hash}`; }
function boardLocation() { return `${location.pathname}${location.search}`; }
function tagsWithScope(tags) { const result = [...new Map((tags || []).map(tag => [String(tag).trim().toLowerCase(), String(tag).trim()])).values()].filter(Boolean); if (state.scopeTag && !result.some(tag => tag.toLowerCase() === state.scopeTag)) result.push(state.scopeTag); return result; }
function toast(title, message = '') { const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = `<strong>${esc(title)}</strong><small>${esc(message)}</small>`; $('#toasts').append(el); setTimeout(() => el.remove(), 4200); }
function formatDate(value, withTime = true) { if (!value) return '无 deadline'; const d = new Date(value); return d.toLocaleString('zh-CN', { month:'short', day:'numeric', ...(withTime ? { hour:'2-digit', minute:'2-digit', second:'2-digit' } : {}) }); }
function isOverdue(t) { return t.deadline && Date.parse(t.deadline) < Date.now() && !['done','cancelled'].includes(t.status); }
function searchableText(t) { return `${t.id} ${t.title} ${t.description} ${(t.tags || []).join(' ')} ${(t.people || []).join(' ')} ${t.projectSlug} ${(t.resources || []).map(x => `${x.title} ${x.url} ${x.note}`).join(' ')}`.toLowerCase(); }
function isClaimed(t) { return validClaim(t, Date.parse(state.sourceAt)); }
function population() { return state.tasks.filter(t => (state.includeTests || !isTestTask(t)) && (state.includeArchives || !isArchivedTask(t))); }
function inScope(t) { return (!state.scopeTag || (t.tags || []).some(tag => tag.toLowerCase() === state.scopeTag)) && (!state.scopePerson || (t.people || []).some(person => person.toLowerCase() === state.scopePerson)); }
function visibleTasks() {
  let list = population().filter(inScope).filter(t => metricMatch(t, state.metric, Date.parse(state.sourceAt)));
  const q = $('#search').value.trim().toLowerCase();
  const p = $('#priority-filter').value;
  if (q) list = list.filter(t => searchableText(t).includes(q));
  // Searching an ID still searches children, while respecting every visible filter.
  if (p === 'p0p1') list = list.filter(t => (t.tags || []).some(tag => /^p[01]$/i.test(tag)));
  else if (p) list = list.filter(t => t.priority === p);
  if (state.filter === 'overdue') list = list.filter(isOverdue);
  if (state.filter === 'today') list = list.filter(t => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString());
  return list;
}
function agentMeta(t) {
  const c = t.claim; const a = t.assignee;
  if (!c && !a) return '';
  const name = c ? (a?.id === c.agentId ? a.name || c.agentId : c.agentId) : a?.name || a?.id;
  return `<span class="agent-pill">${c ? '领取者' : '最近执行者'} · ${esc(name || '未知')}</span>`;
}
function taskId(t) { return `<div class="task-id" title="${esc(t.id)}">ID · ${esc(t.id)}</div>`; }
function readyConflictMarkup(t) { return hasReadyConflict(t) ? `<div class="ready-conflict"><strong>状态需核对 · ready 仍有阻塞说明</strong><span>${esc(t.blockedReason)}</span><small>领取前请核对原详情；此处未解除阻塞或确认依赖。</small></div>` : ''; }
function renderReadyQueue(list) {
  const queue = readyChildQueue(population(), list);
  $('#ready-panel').classList.toggle('hidden', queue.selected.length === 0 && queue.outsideCount === 0);
  $('#ready-panel').classList.toggle('compact-panel', queue.selected.length === 0);
  $('#ready-count').textContent = queue.selected.length;
  $('#ready-subtitle').textContent = `当前筛选 ${queue.selected.length} 项 · 全局 ${queue.globalCount} 项 · 筛选外 ${queue.outsideCount} 项${queue.conflictCount ? `；其中 ${queue.conflictCount} 项状态需核对` : ''}。`;
  $('#show-all-ready').classList.toggle('hidden', queue.outsideCount === 0);
  const shown = state.readyExpanded ? queue.selected : queue.selected.slice(0, 6);
  $('#ready-tasks').innerHTML = shown.map(t => {
    const parent = state.tasks.find(task => task.id === t.parentTaskId);
    return `<article class="ready-card" data-ready-id="${esc(t.id)}"><div class="task-top"><button class="claim-title" data-open-task="${esc(t.id)}">${esc(t.title)}</button><span class="priority priority-${t.priority}">${priorities[t.priority]}</span></div>${taskId(t)}<div class="claim-parent">父方向：${parent ? `<button class="inline-task-link" data-open-task="${esc(parent.id)}">${esc(parent.title)}</button> · ${labels[parent.status]}` : '不在实例授权范围'}</div><div class="task-meta"><span class="status-badge status-ready">原状态 ready</span>${(t.people || []).map(person => `<span class="person-tag">👤 ${esc(person)}</span>`).join('')}${(t.tags || []).map(tag => `<span class="tag">#${esc(tag)}</span>`).join('')}</div>${readyConflictMarkup(t)}${t.description ? `<details class="ready-description"><summary>原说明与依赖（原文）</summary><p>${esc(t.description)}</p></details>` : '<small class="ready-no-description">原任务未提供说明，请进入详情核对验收。</small>'}<button class="inline-task-link ready-detail" data-open-task="${esc(t.id)}">查看原子任务详情 →</button></article>`;
  }).join('');
  $('#toggle-ready').classList.toggle('hidden', queue.selected.length <= 6);
  $('#toggle-ready').textContent = state.readyExpanded ? `收起清单（共 ${queue.selected.length} 项）` : `展开全部 ${queue.selected.length} 项（当前展示 ${shown.length} 项）`;
  $('#toggle-ready').setAttribute('aria-expanded', String(state.readyExpanded));
}
function progressMarkup(t) {
  const report = t.latestReport;
  return `<div class="task-progress">${report ? `<strong>${report.progress === undefined ? esc(labels[t.status] || t.status) : `已记录进度 ${esc(report.progress)}%`}</strong><span>${esc(report.note || '未填写进展说明')}</span><small>报告于 ${formatDate(report.at)}</small>` : '<strong>尚无本次进展报告</strong>'}<small>任务更新 ${formatDate(t.updatedAt)}</small>${t.claim ? `<small>领取于 ${formatDate(t.claim.claimedAt)} · 租约至 ${formatDate(t.claim.leaseUntil)}</small>` : ''}${t.status === 'blocked' && t.blockedReason ? `<span class="danger-text">阻塞：${esc(t.blockedReason)}</span>` : ''}</div>`;
}
function childSummary(parent, matched) {
  const children = state.tasks.filter(t => t.parentTaskId === parent.id);
  if (!children.length) return '';
  const selected = children.filter(t => matched.has(t.id));
  const preview = [...selected].sort((a,b) => Number(isClaimed(b)) - Number(isClaimed(a)) || Number(b.status === 'blocked') - Number(a.status === 'blocked')).slice(0, 3);
  return `<div class="child-summary"><strong>子任务全局汇总 · ${children.length} 项</strong><span>ready ${children.filter(t => t.status === 'ready').length} · 有效领取 ${children.filter(isClaimed).length} · 已完成 ${children.filter(t => t.status === 'done').length} · 阻塞 ${children.filter(t => t.status === 'blocked').length}</span><small>当前筛选匹配 ${selected.length} 项；主任务保持「${esc(labels[parent.status])}」</small>${preview.map(t => `<button class="child-preview" data-open-task="${esc(t.id)}"><span>${esc(t.title)}</span><small>${labels[t.status]} · ${t.latestReport?.progress === undefined ? '无进度报告' : `已记录 ${t.latestReport.progress}%`}</small></button>`).join('')}${selected.length > preview.length ? `<small>其余 ${selected.length-preview.length} 项可进入主任务查看</small>` : ''}</div>`;
}
function card(t, matched = new Set()) {
  const overdue = isOverdue(t);
  const context = !matched.has(t.id);
  return `<article class="task-card" data-id="${esc(t.id)}" tabindex="0" aria-label="查看${esc(t.title)}"><div class="task-top"><div>${context ? '<small class="context-label">关联主任务 · 本身不匹配筛选</small>' : ''}<div class="task-title">${esc(t.title)}</div>${taskId(t)}</div><span class="priority priority-${t.priority}">${(t.tags || []).find(tag => /^p[01]$/i.test(tag))?.toUpperCase() || priorities[t.priority]}</span></div>${directionNote(t, state.tasks) ? `<p class="direction-note">${esc(directionNote(t, state.tasks))}</p>` : ''}${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ''}<div class="task-meta">${t.deadline ? `<span class="deadline ${overdue ? 'overdue' : ''}">◷ ${formatDate(t.deadline)}</span>` : ''}${t.projectSlug ? `<span class="tag">${esc(t.projectSlug)}</span>` : ''}${(t.people || []).map(x => `<span class="person-tag">👤 ${esc(x)}</span>`).join('')}${(t.tags || []).slice(0,2).map(x => `<span class="tag">#${esc(x)}</span>`).join('')}${agentMeta(t)}${verificationBadge(t)}</div>${t.claim || t.latestReport ? progressMarkup(t) : ''}${childSummary(t, matched)}</article>`;
}
function renderOverview(list) {
  const global = population(); const claimed = global.filter(isClaimed); const selectedClaims = list.filter(isClaimed);
  const mainCount = items => items.filter(t => !t.parentTaskId).length;
  $('#stat-ready').textContent = readyChildQueue(global, list).selected.length;
  $('#stat-overdue').textContent = list.filter(isOverdue).length;
  $('#stat-claimed').textContent = selectedClaims.length;
  $('#stat-today').textContent = list.filter(t => !['done','cancelled'].includes(t.status) && t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length;
  $('#nav-count').textContent = list.length;
  renderProgressOverview(list);
  const filters = [state.metric ? $('#metric-filter').selectedOptions[0].textContent : '', state.scopeTag ? `标签 #${state.scopeTag}` : '所有标签', state.scopePerson ? `人员 ${state.scopePerson}` : '所有人员', $('#priority-filter').selectedOptions[0].textContent, $('#search').value.trim() ? `搜索“${$('#search').value.trim()}”` : '', ['overdue','today'].includes(state.filter) ? (state.filter === 'overdue' ? '已逾期' : '今天截止') : ''].filter(Boolean).join(' · ');
  $('#scope-summary').innerHTML = `<strong>当前筛选 · ${esc(filters)}</strong><span>主任务 ${mainCount(list)} · 子任务 ${list.length-mainCount(list)} · 有效领取 ${selectedClaims.length}（主 ${mainCount(selectedClaims)} / 子 ${selectedClaims.length-mainCount(selectedClaims)}）</span><span>全局${state.requiredTag ? `（实例 #${esc(state.requiredTag)}）` : '（当前实例授权范围）'}：主任务 ${mainCount(global)} · 子任务 ${global.length-mainCount(global)} · 有效领取 ${claimed.length}（主 ${mainCount(claimed)} / 子 ${claimed.length-mainCount(claimed)}）</span>`;
  $('#claims-subtitle').textContent = `当前筛选 ${selectedClaims.length} 项 · 筛选外 ${claimed.length-selectedClaims.length} 项；领取与进展报告不代表实时执行探测。`;
  $('#claims-count').textContent = selectedClaims.length;
  $('#claims-panel').classList.toggle('hidden', selectedClaims.length === 0 && claimed.length === 0);
  $('#claims-panel').classList.toggle('compact-panel', selectedClaims.length === 0);
  $('#show-all-claims').classList.toggle('hidden', claimed.length === selectedClaims.length);
  $('#active-claims').innerHTML = selectedClaims.map(t => {
    const parent = global.find(x => x.id === t.parentTaskId);
    return `<article class="claim-card"><button class="claim-title" data-open-task="${esc(t.id)}">${esc(t.title)}</button>${taskId(t)}<div class="task-meta"><span>${t.parentTaskId ? '子任务' : '主任务'}</span>${agentMeta(t)}</div>${t.parentTaskId ? `<div class="claim-parent">所属主任务：${parent ? `<button class="inline-task-link" data-open-task="${esc(parent.id)}">${esc(parent.title)}</button> · ${labels[parent.status]}` : '不在实例授权范围'}</div>` : ''}${progressMarkup(t)}</article>`;
  }).join('');
}
function renderSource() {
  const available = state.available;
  $('#data-status').textContent = available ? `任务来源 /api/board · 读取于 ${formatDate(state.sourceAt)} · 上方统计按当前筛选，主/子任务分别计数。` : `任务来源不可用：${state.error || '尚未完成首次读取'}。${state.sourceAt ? `上次成功读取 ${formatDate(state.sourceAt)}；旧结果已隐藏。` : '尚无成功读取。'}请刷新重试。`;
  $('#data-status').classList.toggle('unavailable', !available);
  $('#connection-label').textContent = available ? '任务来源可用' : '任务来源不可用';
  document.querySelector('.connection i').style.background = available ? 'var(--accent)' : 'var(--red)';
  $('#server-time').textContent = available ? formatDate(state.sourceAt) : '不可用';
}
function syncNavigation() { document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === state.view)); document.querySelectorAll('.side-link').forEach(x => x.style.color = x.dataset.filter === state.filter ? 'var(--accent)' : ''); }
function renderRecent() { $('#recent-tasks').innerHTML = state.recent.length ? state.recent.map((t, index) => `<button class="recent-task ${state.currentTask?.id === t.id ? 'active' : ''}" data-recent-id="${esc(t.id)}"><span class="recent-index">0${index + 1}</span><span><strong>${esc(t.title)}</strong><small>${labels[t.status]} · ${formatDate(t.updatedAt, false)}</small></span></button>`).join('') : '<div class="recent-empty">还没有最近主任务</div>'; }
function renderScope() {
  $('#page-title').textContent = state.scopeTag ? `#${state.scopeTag} 待办` : '任务中心';
  $('#page-subtitle').textContent = state.scopePerson ? `当前显示 ${state.scopePerson} 参与的任务。` : state.scopeTag ? `当前只显示并创建带 #${state.scopeTag} 标签的任务。` : '把重要的事交给自己，也交给 Agent。';
  $('#board-subtitle').textContent = '有内容的主单状态各占一行；可领取执行项见上方子任务队列，关联主卡不计入筛选数量。';
  document.title = state.scopeTag ? `#${state.scopeTag} 待办 · ForgeaX` : 'Task Board · ForgeaX';
}
function renderTagOptions() {
  const options = state.tags.map(({ tag, count }) => `<option value="${esc(tag)}">#${esc(tag)}（${count}）</option>`).join('');
  const missing = state.scopeTag && !state.tags.some(item => item.tag === state.scopeTag) ? `<option value="${esc(state.scopeTag)}">#${esc(state.scopeTag)}（${state.available ? 0 : '数量未知'}）</option>` : '';
  $('#tag-filter').innerHTML = `<option value="">所有标签</option>${missing}${options}`;
  $('#tag-filter').value = state.scopeTag;
}
function renderPeopleOptions() {
  const options = state.people.map(({ person, count }) => `<option value="${esc(person.toLowerCase())}">${esc(person)}（${count}）</option>`).join('');
  const missing = state.scopePerson && !state.people.some(item => item.person.toLowerCase() === state.scopePerson) ? `<option value="${esc(state.scopePerson)}">${esc(state.scopePerson)}（${state.available ? 0 : '数量未知'}）</option>` : '';
  $('#person-filter').innerHTML = `<option value="">所有人员</option>${missing}${options}`;
  $('#person-filter').value = state.scopePerson;
}
function render() {
  renderSource();
  const list = visibleTasks(); const matched = new Set(list.map(t => t.id));
  const parents = state.tasks.filter(t => !t.parentTaskId && (matched.has(t.id) || state.tasks.some(child => child.parentTaskId === t.id && matched.has(child.id))));
  // A child remains visible even when its parent is outside the authorized instance.
  const entries = [...parents, ...list.filter(t => t.parentTaskId && !state.tasks.some(parent => parent.id === t.parentTaskId))];
  if (state.available) {
    renderOverview(list);
    renderReadyQueue(list);
    $('#board-heading').classList.toggle('hidden', list.length === 0);
    $('#board').innerHTML = list.length ? columns.map(status => {
      const items = entries.filter(t => t.status === status);
      if (!items.length) return '';
      const label = status === 'inbox' ? '方向管理 · 待推进' : status === 'ready' ? '主单可领取' : labels[status];
      return `<section class="column" data-status="${status}" aria-label="${label}"><div class="column-head"><span class="dot ${status === 'claimed' ? 'urgent' : status === 'done' ? 'normal' : 'high'}"></span><strong>${label}</strong><b>${items.length}</b></div><div class="column-body">${items.map(t => card(t, matched)).join('')}</div></section>`;
    }).join('') : '<div class="empty board-empty" role="status">当前筛选没有匹配任务，请调整筛选或搜索。</div>';
    document.querySelectorAll('.task-card').forEach(el => {
      el.addEventListener('click', e => { if (!e.target.closest('button')) void openDetail(el.dataset.id); });
      el.addEventListener('keydown', e => { if (e.target === el && ['Enter',' '].includes(e.key)) { e.preventDefault(); void openDetail(el.dataset.id); } });
    });
    document.querySelectorAll('[data-open-task]').forEach(el => el.onclick = e => { e.stopPropagation(); void openDetail(el.dataset.openTask); });
    const dated = list.filter(t => t.deadline).sort((a,b) => Date.parse(a.deadline)-Date.parse(b.deadline));
    $('#timeline').innerHTML = dated.length ? dated.map(t => `<div class="timeline-item"><div class="timeline-date">${formatDate(t.deadline)}</div><button class="timeline-card" data-id="${esc(t.id)}"><div class="task-title">${esc(t.title)}</div>${taskId(t)}<span>${t.parentTaskId ? '子任务' : '主任务'} · ${labels[t.status]}</span></button></div>`).join('') : '<div class="empty">当前筛选没有设置 deadline 的任务</div>';
    document.querySelectorAll('.timeline-card').forEach(el => el.onclick = () => void openDetail(el.dataset.id));
    state.recent = [...parents].sort((a,b) => {
      const latest = t => Math.max(Date.parse(t.updatedAt), ...list.filter(child => child.parentTaskId === t.id).map(child => Date.parse(child.updatedAt)));
      return latest(b)-latest(a);
    }).slice(0,3);
    state.tags = [...new Set(population().filter(t => !state.scopePerson || (t.people || []).some(p => p.toLowerCase() === state.scopePerson)).flatMap(t => t.tags || []).map(t => t.toLowerCase()))].map(tag => ({tag,count:population().filter(t => (t.tags || []).some(x => x.toLowerCase() === tag) && (!state.scopePerson || (t.people || []).some(p => p.toLowerCase() === state.scopePerson))).length})).sort((a,b) => b.count-a.count || a.tag.localeCompare(b.tag));
    const scoped = population().filter(t => !state.scopeTag || (t.tags || []).some(tag => tag.toLowerCase() === state.scopeTag));
    state.people = [...new Set(scoped.flatMap(t => t.people || []).map(p => p.toLowerCase()))].map(person => ({person,count:scoped.filter(t => (t.people || []).some(p => p.toLowerCase() === person)).length})).sort((a,b) => b.count-a.count || a.person.localeCompare(b.person));
  } else {
    ['stat-ready','stat-overdue','stat-claimed','stat-today','nav-count'].forEach(id => $('#'+id).textContent = '—');
    $('#progress-overview').innerHTML = '<p class="danger-text">任务概览不可用；旧图表与统计已隐藏。请刷新重试。</p>';
    $('#scope-summary').textContent = '当前筛选与全局统计不可用';
    $('#ready-panel').classList.add('hidden'); $('#claims-panel').classList.add('hidden'); $('#board-heading').classList.add('hidden');
    $('#claims-subtitle').textContent = '来源不可用，不能判断当前领取。';
    $('#show-all-claims').classList.add('hidden');
    $('#ready-count').textContent = '—';
    $('#ready-subtitle').textContent = '来源不可用，不能判断可领取子任务。';
    $('#show-all-ready').classList.add('hidden'); $('#toggle-ready').classList.add('hidden');
    $('#ready-tasks').innerHTML = '<div class="empty">任务来源不可用；旧成功结果已隐藏</div>';
    $('#active-claims').innerHTML = $('#board').innerHTML = $('#timeline').innerHTML = '<div class="empty">任务来源不可用；旧成功结果已隐藏</div>';
    state.recent = []; state.tags = []; state.people = [];
  }
  $('#board-view').classList.toggle('hidden', state.view !== 'board'); $('#timeline-view').classList.toggle('hidden', state.view !== 'timeline'); $('#task-detail-view').classList.toggle('hidden', state.view !== 'detail');
  if (state.view === 'detail') { if (state.available) renderDetail(); else $('#detail-content').innerHTML = '<div class="empty">任务来源不可用，请刷新后核对详情。</div>'; }
  renderScope(); renderTagOptions(); renderPeopleOptions(); renderRecent(); syncNavigation();
}
let refreshSequence = 0;
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const [snapshot, detail] = await Promise.all([api('/api/board'), state.currentTask?.id ? api(`/api/tasks/${encodeURIComponent(state.currentTask.id)}`) : Promise.resolve(null)]);
    if (sequence !== refreshSequence) return;
    if (!Array.isArray(snapshot.tasks) || !snapshot.sourceAt) throw new Error('来源快照格式无效');
    state.tasks = snapshot.tasks; state.sourceAt = snapshot.sourceAt; state.requiredTag = snapshot.requiredTag || ''; state.available = true; state.error = '';
    if (detail && state.currentTask?.id === detail.id) state.currentTask = detail;
  } catch (error) {
    if (sequence !== refreshSequence) return;
    state.available = false; state.error = error.message;
  }
  render();
}
async function configureSession() { try { const session = await api('/api/session'); $('#logout-btn').classList.toggle('hidden', !session.authEnabled); } catch {} }
async function logout() { try { await fetch('/api/logout', { method:'POST' }); } finally { const next = `${location.pathname}${location.search}${location.hash}`; location.replace(`/login?next=${encodeURIComponent(next)}`); } }
async function openDetail(id, updateHash = true) { if (!id) return; state.view = 'detail'; if (updateHash) history.replaceState(null, '', `${boardLocation()}#task=${encodeURIComponent(id)}`); $('#board-view').classList.add('hidden'); $('#timeline-view').classList.add('hidden'); $('#task-detail-view').classList.remove('hidden'); $('#detail-content').innerHTML = '<div class="loading">正在加载任务详情…</div>'; syncNavigation(); try { state.currentTask = await api(`/api/tasks/${encodeURIComponent(id)}`); render(); } catch (e) { toast('详情加载失败', e.message); goBack(); } }
function goBack() { state.currentTask = null; state.view = 'board'; history.replaceState(null, '', boardLocation()); render(); }
function parentOptions(selected = '', currentId = '') { return `<option value="">主任务（无归属）</option>${state.tasks.filter(t => !t.parentTaskId && t.id !== currentId && (!state.scopeTag || (t.tags || []).some(tag => tag.toLowerCase() === state.scopeTag))).map(t => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}`; }
function openNew(parentId = '') { $('#modal-title').textContent = parentId ? '新建子任务' : '新建主任务'; $('#task-id').value = ''; $('#task-form').reset(); acceptanceEditor([]); $('#task-result').value=''; $('#task-status').value = 'ready'; $('#task-priority').value = 'normal'; $('#task-tags').value = state.scopeTag; $('#task-people').value = state.scopePerson; $('#task-parent').innerHTML = parentOptions(parentId); $('#task-parent').value = parentId; $('#delete-task').classList.add('hidden'); $('#modal').classList.remove('hidden'); setTimeout(() => $('#task-title').focus(), 80); }
function openEdit(id) { const t = state.currentTask?.id === id ? state.currentTask : state.tasks.find(x => x.id === id); if (!t) return; $('#modal-title').textContent = t.parentTaskId ? '编辑子任务' : '编辑主任务'; $('#task-id').value = t.id; $('#task-title').value = t.title; $('#task-description').value = t.description; acceptanceEditor(t.acceptanceCriteria||[]); $('#task-result').value=t.result||''; $('#task-status').value = t.status; $('#task-priority').value = t.priority; $('#task-deadline').value = t.deadline ? new Date(t.deadline).toISOString().slice(0,16) : ''; $('#task-project').value = t.projectSlug; $('#task-tags').value = (t.tags || []).join(', '); $('#task-people').value = (t.people || []).join(', '); $('#task-parent').innerHTML = parentOptions(t.parentTaskId || '', t.id); $('#task-parent').value = t.parentTaskId || ''; $('#delete-task').classList.remove('hidden'); $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
async function submit(e) { e.preventDefault(); const id = $('#task-id').value; const input = { acceptanceCriteria:acceptanceInput(), result:$('#task-result').value.trim(), title: $('#task-title').value.trim(), description: $('#task-description').value.trim(), status: $('#task-status').value, priority: $('#task-priority').value, deadline: $('#task-deadline').value ? new Date($('#task-deadline').value).toISOString() : null, projectSlug: $('#task-project').value.trim(), tags: id && state.currentTask && !inScope(state.currentTask) ? $('#task-tags').value.split(',').map(x=>x.trim()).filter(Boolean) : tagsWithScope($('#task-tags').value.split(',').map(x=>x.trim()).filter(Boolean)), people: $('#task-people').value.split(',').map(x=>x.trim()).filter(Boolean), parentTaskId: $('#task-parent').value || null }; try { if(input.status==='done' && input.acceptanceCriteria.some(item=>item.status!=='passed'||!item.evidence))return toast('不能标记完成','逐项实际通过并补齐证据；未通过请标记受阻。'); const saved = await api(id ? `/api/tasks/${id}` : scopedPath('/api/tasks'), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(input) }); const leavesPersonScope = state.scopePerson && !(saved.people || []).some(person => person.toLowerCase() === state.scopePerson); if (leavesPersonScope) { state.currentTask = null; state.view = 'board'; history.replaceState(null, '', `${location.pathname}${location.search}`); } closeModal(); await refresh(); toast(id ? '任务已更新' : (input.parentTaskId ? '子任务已创建' : '主任务已创建')); if (!leavesPersonScope && (!id || state.view === 'detail')) await openDetail(saved.id, false); } catch (e) { toast('保存失败', e.message); } }
async function deleteTask() { const id = $('#task-id').value; if (!id || !confirm('确定删除这个任务吗？主任务的子任务也会一起删除。')) return; try { await api(`/api/tasks/${id}`, { method:'DELETE' }); closeModal(); goBack(); await refresh(); toast('任务已删除'); } catch (e) { toast('删除失败', e.message); } }
function resourceCard(resource) { return `<div class="resource-item"><div><a href="${safeHref(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.title)}</a><small>${esc(resource.url)}</small>${resource.note ? `<p>${esc(resource.note)}</p>` : ''}</div><button class="icon-action danger-text" data-remove-resource="${esc(resource.id)}" title="删除资料">×</button></div>`; }
function resourceGroup(task, kind) { const resources = task.resourcesByKind?.[kind] || []; return `<section class="resource-group"><div class="resource-group-head"><div><h4>${resourceKinds[kind]}</h4><span>${resources.length ? `${resources.length} 项已关联` : '还没有关联资料'}</span></div></div>${resources.length ? `<div class="resource-list">${resources.map(resourceCard).join('')}</div>` : ''}<form class="resource-form" data-resource-kind="${kind}"><input name="title" required placeholder="资料名称，例如：PRD v2 / BUG-123" /><input name="url" required placeholder="链接或仓库相对路径" /><input name="note" placeholder="备注（可选）" /><button class="ghost" type="submit">＋ 关联</button></form></section>`; }
function agentPanel(task) {
  const claim = task.claim; const assignee = task.assignee; const report = task.latestReport;
  if (!claim && !assignee) return `<div class="agent-empty"><span class="agent-icon">◉</span><div><strong>尚未有 Agent 领取</strong><p>读取详情不等于领取；领取后仍需进展报告证明实际工作。</p></div></div>`;
  const name = claim ? (assignee?.id === claim.agentId ? assignee.name || claim.agentId : claim.agentId) : assignee?.name || assignee?.id;
  return `<div class="agent-panel"><div class="agent-avatar">◉</div><div class="agent-info"><strong>${claim ? '领取者' : '最近执行者'} · ${esc(name || '未知')}</strong><span>${esc(claim?.process || assignee?.process || 'agent')} · ${esc(claim?.cwd || assignee?.cwd || '工作目录未知')}</span>${claim ? `<small>Lease 至 ${formatDate(claim.leaseUntil)} · 领取于 ${formatDate(claim.claimedAt)}</small>` : ''}</div>${report?.progress === undefined ? '' : `<div class="progress-ring"><b>${report.progress}%</b><span>已记录</span></div>`}</div><div class="task-progress">${report ? `<span>${esc(report.note || '未填写进展说明')}</span><small>报告于 ${formatDate(report.at)}</small>` : '<span>尚无本次进展报告</span>'}</div>`;
}
function historyMarkup(task) { const history = [...(task.history || [])].reverse(); return history.length ? `<div class="history-list">${history.map(item => `<div class="history-item"><i class="history-dot"></i><div><strong>${esc(item.type)}</strong><span>${formatDate(item.at)} · ${esc(item.actor)}</span>${item.note ? `<p>${esc(item.note)}</p>` : ''}</div>${item.progress === undefined ? '' : `<b>${item.progress}%</b>`}</div>`).join('')}</div>` : '<div class="empty">暂无历史记录</div>'; }
function taskLink(task, label = task.title) { return `<button class="inline-task-link" data-task-id="${esc(task.id)}">${esc(label)}</button>`; }
function renderDetail() {
  const task = state.currentTask; if (!task) { $('#detail-content').innerHTML = '<div class="empty">选择一个主任务查看详情</div>'; return; }
  const isMain = task.isMainTask ?? !task.parentTaskId; const overdue = isOverdue(task); const parentBlock = task.parentTask ? `<div class="task-relation"><span>所属主任务</span>${taskLink(task.parentTask)}</div>` : ''; const mainBlock = task.mainTask ? `<div class="task-relation"><span>主任务</span>${taskLink(task.mainTask)}</div>` : '';
  $('#detail-content').innerHTML = `<div class="detail-head"><div><div class="eyebrow">${isMain ? 'MAIN TASK' : 'SUBTASK'} / ${esc(task.id)}</div><h2>${esc(task.title)}</h2><div class="detail-badges"><span class="status-badge status-${task.status}">${labels[task.status]}</span>${verificationBadge(task)}<span class="priority priority-${task.priority}">${priorities[task.priority]}</span>${(task.people || []).map(person => `<span class="person-tag">👤 ${esc(person)}</span>`).join('')}${task.deadline ? `<span class="deadline ${overdue ? 'overdue' : ''}">◷ ${overdue ? '已逾期 · ' : ''}${formatDate(task.deadline)}</span>` : ''}</div></div><div class="detail-actions"><button class="ghost" id="edit-current">编辑</button>${isMain ? `<button class="primary" id="add-subtask">＋ 子任务</button>` : ''}</div></div><div class="detail-grid"><div class="detail-main"><section class="detail-card description-card"><div class="section-kicker">任务说明</div>${directionNote(task, state.tasks) ? `<p class="direction-note">${esc(directionNote(task, state.tasks))}</p>` : ''}${readyConflictMarkup(task)}<p>${task.description ? esc(task.description) : '暂无任务描述。'}</p>${parentBlock}${mainBlock}${task.result ? `<div class="result-block"><strong>交付结果</strong><p>${esc(task.result)}</p></div>` : ''}</section>${acceptancePanel(task)}${verificationPanel(task)}${isMain ? `<section class="detail-card"><div class="section-heading"><div><div class="section-kicker">任务拆解</div><h3>子任务 <span>${task.subtasks?.length || 0}</span></h3></div><button class="ghost" id="add-subtask-inline">＋ 添加子任务</button></div>${task.subtasks?.length ? `<div class="subtask-list">${task.subtasks.map(child => `<button class="subtask-row" data-task-id="${esc(child.id)}"><span class="subtask-status status-${child.status}"></span><span class="subtask-title">${esc(child.title)}</span><span>${labels[child.status]} · ${verificationLabels[child.verification?.status || 'pending']}</span><b>${child.latestReport?.progress === undefined ? '无进度报告' : `已记录 ${child.latestReport.progress}%`}</b></button>`).join('')}</div>` : '<div class="empty compact">还没有子任务，可以把执行步骤拆开交给不同 Agent。</div>'}</section>` : ''}<section class="detail-card"><div class="section-heading"><div><div class="section-kicker">关联资料</div><h3>需求、Bug 与验收证据</h3></div><span class="section-hint">Agent 读取 / claim 时同步获得</span></div><div class="resource-groups">${Object.keys(resourceKinds).map(kind => resourceGroup(task, kind)).join('')}</div></section></div><aside class="detail-side"><section class="detail-card agent-card"><div class="section-kicker">Agent 协作状态</div>${agentPanel(task)}<div class="agent-context-note">people 是人工协作者；claim 是当前唯一的 Agent 租约。详情接口会同时返回两者。</div></section><section class="detail-card"><div class="section-heading"><div><div class="section-kicker">Activity</div><h3>任务历史</h3></div></div>${historyMarkup(task)}</section></aside></div>`;
  $('#verification-form').onsubmit = submitVerification;
  $('#edit-current').onclick = () => openEdit(task.id); if (isMain) { $('#add-subtask').onclick = () => openNew(task.id); $('#add-subtask-inline').onclick = () => openNew(task.id); } document.querySelectorAll('[data-task-id]').forEach(el => el.addEventListener('click', () => void openDetail(el.dataset.taskId))); document.querySelectorAll('[data-remove-resource]').forEach(el => el.addEventListener('click', () => void removeResource(el.dataset.removeResource))); document.querySelectorAll('.resource-form').forEach(form => form.addEventListener('submit', (e) => void addResource(e, form.dataset.resourceKind)));
}
async function addResource(e, kind) { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); try { const saved = await api(`/api/tasks/${state.currentTask.id}/resources`, { method:'POST', body: JSON.stringify({ kind, title:data.get('title'), url:data.get('url'), note:data.get('note'), actorId:'human' }) }); state.currentTask = saved; form.reset(); await refresh(); toast('资料已关联', resourceKinds[kind]); } catch (e) { toast('关联失败', e.message); } }
async function removeResource(id) { if (!confirm('确定移除这条关联资料吗？')) return; try { state.currentTask = await api(`/api/tasks/${state.currentTask.id}/resources/${encodeURIComponent(id)}`,  { method:'DELETE' }); await refresh(); toast('资料关联已移除'); } catch (e) { toast('移除失败', e.message); } }
function enableNotifications() { if (!('Notification' in window)) return toast('当前浏览器不支持通知'); Notification.requestPermission().then(p => toast(p === 'granted' ? '通知已开启' : '通知未开启', '每天 10:00 将提醒你查看待办')); }
function handleEvent(evt) { try { const data = JSON.parse(evt.data); if (data.type === 'daily.reminder') { toast('早安，今天的任务准备好了', `待处理 ${data.count} 项 · 逾期 ${data.overdue} 项`); if (Notification.permission === 'granted') new Notification('ForgeaX 任务提醒', { body: `待处理 ${data.count} 项，逾期 ${data.overdue} 项，今天截止 ${data.dueToday} 项` }); } if (data.type?.startsWith('task.')) void refresh(); } catch {} }

document.addEventListener('click', (e) => { const nav = e.target.closest('[data-view]'); if (nav) { state.view = nav.dataset.view; state.currentTask = null; history.replaceState(null, '', boardLocation()); render(); } const filter = e.target.closest('[data-filter]'); if (filter) { state.filter = filter.dataset.filter; $('#priority-filter').value = ['p0p1', 'urgent', 'high', 'normal', 'low'].includes(state.filter) ? state.filter : ''; state.view = 'board'; state.currentTask = null; render(); } const recent = e.target.closest('[data-recent-id]'); if (recent) void openDetail(recent.dataset.recentId); const back = e.target.closest('[data-back]'); if (back) goBack(); });
$('#add-acceptance').onclick=()=>appendAcceptance();
$('#new-task').onclick = () => openNew(); $('#close-modal').onclick = closeModal; $('#cancel-form').onclick = closeModal; $('#delete-task').onclick = deleteTask; $('#task-form').onsubmit = submit; $('#notify-btn').onclick = enableNotifications; $('#logout-btn').onclick = () => void logout(); $('#refresh').onclick = () => void refresh(); $('#search').oninput = render; $('#tag-filter').onchange = () => { state.scopeTag = $('#tag-filter').value; const url = new URL(location.href); if (state.scopeTag) url.searchParams.set('tag', state.scopeTag); else url.searchParams.delete('tag'); url.hash = ''; history.replaceState(null, '', `${url.pathname}${url.search}`); state.filter = state.scopeTag ? 'all' : 'p0p1'; $('#priority-filter').value = state.scopeTag ? '' : 'p0p1'; state.currentTask = null; state.view = 'board'; render(); }; $('#priority-filter').onchange = () => { state.filter = $('#priority-filter').value || 'all'; render(); }; $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); }; $('#date-label').textContent = new Date().toLocaleDateString('zh-CN', { month:'long', day:'numeric', weekday:'long' }); $('#priority-filter').value = state.scopeTag ? '' : 'p0p1';
$('#person-filter').onchange = () => { state.scopePerson = $('#person-filter').value; const url = new URL(location.href); if (state.scopePerson) url.searchParams.set('person', state.scopePerson); else url.searchParams.delete('person'); url.hash = ''; history.replaceState(null, '', `${url.pathname}${url.search}`); state.currentTask = null; state.view = 'board'; render(); };
window.addEventListener('hashchange', () => { const id = new URLSearchParams(location.hash.replace(/^#/, '')).get('task'); if (id) void openDetail(id, false); });
const hashTask = new URLSearchParams(location.hash.replace(/^#/, '')).get('task'); if (hashTask) void openDetail(hashTask, false);
const events = new EventSource('/api/events'); events.onmessage = handleEvent; events.onopen = () => void refresh(); events.onerror = () => void refresh();
void configureSession();
void refresh();

function showAllTasks() {
  state.scopeTag = ''; state.scopePerson = ''; state.filter = 'all';
  state.readyExpanded = false; state.metric = ''; $('#metric-filter').value = '';
  $('#priority-filter').value = ''; $('#search').value = '';
  const url = new URL(location.href); url.searchParams.delete('tag'); url.searchParams.delete('person'); url.hash = '';
  history.replaceState(null, '', `${url.pathname}${url.search}`); render();
}
$('#show-all-claims').onclick = showAllTasks;
$('#show-all-ready').onclick = showAllTasks;
$('#toggle-ready').onclick = () => { state.readyExpanded = !state.readyExpanded; render(); };

$('#metric-filter').onchange = () => { state.metric = $('#metric-filter').value; render(); };
$('#include-tests').onchange = () => { state.includeTests = $('#include-tests').checked; render(); };

$('#include-archives').onchange = () => { state.includeArchives = $('#include-archives').checked; render(); };
