import { createHash } from 'node:crypto';
import { completionError, type AcceptanceCriterion } from './acceptance';

export type Verification = {
  status: 'pending' | 'verified' | 'failed' | 'insufficient' | 'invalidated';
  reviewer: string; at: string | null; evidence: string; basis: string;
  invalidatedAt?: string; reason?: string;
};
type Subject = {
  status: string; title: string; description: string; result: string;
  acceptanceCriteria: AcceptanceCriterion[]; verification?: Verification;
};
// Bind actual delivery and acceptance evidence; descriptive edits and renewals do not invalidate review.
export function verificationBasis(task: Subject) {
  return createHash('sha256').update(JSON.stringify({
    result: task.result,
    acceptanceCriteria: [...task.acceptanceCriteria].sort((a,b) => a.id.localeCompare(b.id)),
  })).digest('hex');
}
export function verificationView(task: Subject): Verification {
  const current = task.verification;
  if (!current) return { status:'pending', reviewer:'', at:null, evidence:'', basis:'' };
  if (current.status === 'verified' && (task.status !== 'done' || current.basis !== verificationBasis(task)
    || !task.acceptanceCriteria.length || completionError(task.acceptanceCriteria) || !String(task.result ?? '').trim())) {
    return { ...current, status:'invalidated', reason:'交付或验收依据已变化，需重新验证' };
  }
  return current;
}
export function verificationError(task: Subject, input: Record<string, unknown>) {
  if (!['verified','failed','insufficient','pending'].includes(String(input.status))) return '验证状态必须为 verified / failed / insufficient / pending';
  if (typeof input.reviewer !== 'string' || !input.reviewer.trim() || input.reviewer.length > 200) return '请填写验证人（最多200字）';
  if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4000) return '请填写实际验证证据或未通过/证据不足的具体原因（最多4000字）';
  if (input.expectedBasis !== verificationBasis(task)) return '任务交付或验收依据已变化，请刷新详情后重新核对';
  if (input.status === 'pending') return null;
  if (task.status !== 'done') return '请先按原逐项验收门槛完成任务，再记录验证结果';
  if (input.status === 'verified') {
    if (!task.acceptanceCriteria.length) return '验证完成需要明确的逐项验收标准与证据；历史 done 不自动视为已验证';
    if (completionError(task.acceptanceCriteria) || !String(task.result ?? '').trim()) return '原逐项验收尚未通过或缺少实际交付结果，不能记录验证完成';
  }
  return null;
}
