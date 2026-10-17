import { z } from 'zod';
import {
  type Data,
  type Pack,
  type Proposal,
  fieldDefinition,
  normalisePath,
  get,
  set,
  PlatformError,
} from './model';
import { evaluate } from './engine';

export const proposalSchema = z
  .object({
    errorClass: z.literal('data'),
    diagnosis: z.string().min(1).max(2000),
    patch: z
      .array(
        z
          .object({
            op: z.enum(['replace', 'add']),
            path: z.string().min(2),
            value: z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.null()]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    citedFields: z.array(z.string()).min(1).max(30),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export function pointer(path: string): string {
  if (!path.startsWith('/') || path.includes('~') || path.includes('//'))
    throw new PlatformError('PATCH_PATH', 'Only canonical leaf JSON pointers are supported');
  return path
    .slice(1)
    .split('/')
    .map((p, i) => (/^\d+$/.test(p) ? `[${p}]` : i ? `.${p}` : p))
    .join('');
}
export function fieldSlice(data: Data, paths: string[]): Data {
  const result: Data = {};
  for (const path of paths) {
    if (path.includes('*'))
      throw new PlatformError(
        'FIELD_SLICE',
        'Resolve concrete field paths before requesting a proposal',
      );
    result[path] = get(data, path) ?? null;
  }
  return result;
}
export function validateProposal(
  pack: Pack,
  data: Data,
  input: unknown,
  failingRule: string,
  options: {
    humanApproved?: boolean;
    source?: 'playbook' | 'llm';
    autoApplyEnabled?: boolean;
    shadow?: boolean;
  } = {},
): { data: Data; apply: boolean; reason: string; proposal: Proposal } {
  const proposal = proposalSchema.parse(input),
    next = structuredClone(data);
  const rule = pack.rules.rules.find((r) => r.id === failingRule);
  if (!rule) throw new PlatformError('PROPOSAL_RULE', 'Unknown failing rule');
  let protectedChange = false;
  for (const op of proposal.patch) {
    const path = pointer(op.path),
      field = fieldDefinition(pack, path);
    if (
      !field ||
      !proposal.citedFields.includes(path) ||
      !rule.fields.some((p) => p === normalisePath(path))
    )
      throw new PlatformError('PATCH_SCOPE', `Patch outside the failing rule field scope: ${path}`);
    if (field.declaredBy === 'customer')
      throw new PlatformError(
        'DECLARED_FIELD',
        'Automated proposals may not set customer declarations',
      );
    if (pack.protected.protected.includes(normalisePath(path))) protectedChange = true;
    set(next, path, op.value);
  }
  const before = evaluate(pack, data),
    after = evaluate(pack, next),
    oldFailures = new Set(before.rules.filter((r) => !r.passed).map((r) => r.id));
  if (
    after.rules.some((r) => r.id === failingRule && !r.passed) ||
    after.rules.some((r) => !r.passed && !oldFailures.has(r.id))
  )
    throw new PlatformError(
      'FIX_REGRESSION',
      'Fix fails its target rule or introduces another failure',
    );
  if (options.shadow) return { data: next, apply: false, reason: 'shadow_mode', proposal };
  if (protectedChange && !options.humanApproved)
    return { data: next, apply: false, reason: 'protected_field_review', proposal };
  if (!options.humanApproved && options.source !== 'playbook' && !options.autoApplyEnabled)
    return { data: next, apply: false, reason: 'llm_auto_apply_disabled', proposal };
  return {
    data: next,
    apply: true,
    reason: options.humanApproved ? 'approved' : 'auto_applied',
    proposal,
  };
}
