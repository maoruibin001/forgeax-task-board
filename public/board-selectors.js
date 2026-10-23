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
