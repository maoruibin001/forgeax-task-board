// Explicit acceptance records are evidence claims, not independent verification.
// The reviewer must inspect the referenced result before recording "passed".
export type AcceptanceCriterion = { id: string; criterion: string; status: 'pending' | 'passed' | 'failed'; evidence: string };

export function parseAcceptance(value: unknown): { criteria: AcceptanceCriterion[]; error?: string } {
  if (!Array.isArray(value) || value.length > 40) return { criteria: [], error: '验收项必须是数组，最多40项' };
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { criteria: [], error: '验收项格式不正确' };
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)
      || typeof item.criterion !== 'string' || !item.criterion.trim() || item.criterion.length > 500
      || !['pending', 'passed', 'failed'].includes(String(item.status))
      || typeof item.evidence !== 'string' || item.evidence.length > 2000) return { criteria: [], error: '验收项需要唯一ID、标准、状态和证据；状态为pending/passed/failed' };
    seen.add(item.id);
    criteria.push({ id: item.id, criterion: item.criterion.trim(), status: item.status as AcceptanceCriterion['status'], evidence: item.evidence.trim() });
  }
  return { criteria };
}

export function completionError(criteria: AcceptanceCriterion[], previous: AcceptanceCriterion[] = []): string | null {
  if (previous.some(old => !criteria.some(next => next.id === old.id && next.criterion === old.criterion)))
    return '不能在标记完成时移除或改写原验收标准；请先核对需求变更';
  if (criteria.some(item => item.status !== 'passed' || !item.evidence.trim()))
    return '验收尚未全部通过或缺少实际证据；请标记受阻并交个人分身判断';
  return null;
}
