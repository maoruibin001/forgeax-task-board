// Project only the current /api/board snapshot; never infer dependency clearance.
export function readyChildQueue(allTasks, matchingTasks) {
  const isReadyChild = task => Boolean(task.parentTaskId) && task.status === 'ready';
  const global = allTasks.filter(isReadyChild);
  const selected = matchingTasks.filter(isReadyChild);
  return {
    selected,
    globalCount: global.length,
    outsideCount: global.length - selected.length,
    conflictCount: selected.filter(hasReadyConflict).length,
  };
}

export function hasReadyConflict(task) {
  return task.status === 'ready' && Boolean(task.blockedReason?.trim());
}

export function directionNote(task, allTasks) {
  if (task.parentTaskId || task.status !== 'inbox') return '';
  const count = allTasks.filter(child => child.parentTaskId === task.id).length;
  return count
    ? `方向管理 · 已拆解 ${count} 项子任务，待推进与跟进；容器原状态 inbox。`
    : '方向管理 · 待明确下一步；当前尚无子任务，容器原状态 inbox。';
}

export function isTestTask(task) {
  return task.test === true || (task.tags || []).some(tag => String(tag).trim().toLowerCase() === 'test=true');
}
export function isArchivedTask(task) {
  // The existing archive is tagged in the same task store; never infer archive from done/cancelled.
  return (task.tags || []).some(tag => /^archived-\d{8}$/i.test(String(tag).trim()));
}
export function validClaim(task, at) {
  return task.status === 'claimed' && Boolean(task.claim) && Date.parse(task.claim.leaseUntil) > at;
}
export function verifiedTask(task) {
  return task.status === 'done' && task.verification?.status === 'verified';
}
export function metricMatch(task, metric, at) {
  if (metric === 'claimed') return validClaim(task, at);
  if (metric === 'verified') return verifiedTask(task);
  if (['pending','failed','insufficient','invalidated'].includes(metric)) return (task.verification?.status || 'pending') === metric;
  return !metric || task.status === metric;
}
export function taskMetrics(tasks, at) {
  const count = predicate => tasks.filter(predicate).length;
  const claimed = tasks.filter(task => validClaim(task, at));
  // A report is evidence of a reported action in this claim round, never a live process probe.
  const reported = claimed.filter(task => task.latestReport?.type === 'progress'
    && task.latestReport.actor === task.claim.agentId
    && Date.parse(task.latestReport.at) >= Date.parse(task.claim.claimedAt));
  return {
    total: tasks.length, main: count(task => !task.parentTaskId), child: count(task => Boolean(task.parentTaskId)),
    done: count(task => task.status === 'done'), claimed: claimed.length, verified: count(verifiedTask),
    reported: reported.length, unknown: claimed.length - reported.length,
    blocked: count(task => task.status === 'blocked'), cancelled: count(task => task.status === 'cancelled'),
  };
}
