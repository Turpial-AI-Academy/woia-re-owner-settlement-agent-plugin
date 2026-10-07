import { createHash } from 'node:crypto';

export const actions = Object.freeze(['import', 'read', 'extract-link', 'source-version.accept', 'reconcile', 'delivery-package'].map(x => `owner-settlement.${x}`));
const fail = (condition, code) => { if (!condition) throw new Error(code); };
const text = x => typeof x === 'string' && x.trim().length > 0;
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
export const payloadDigest = x => createHash('sha256').update(canonical(x)).digest('hex');
export const emptyState = (org, id) => ({ org, id, revision: 0, versions: {}, history: [], operations: {} });

// Context must be resolved from trusted current organization resources, never from model assertions.
function guard(state, command, context) {
  fail(actions.includes(command.action), 'ACTION_FORBIDDEN');
  fail(context && text(context.actor) && text(context.task), 'ACTOR_REQUIRED');
  fail(context.org === state.org && command.org === state.org && command.id === state.id, 'SCOPE_MISMATCH');
  fail(['finance', 'asset-management', 'customer-service'].includes(context.department), 'DEPARTMENT_DENIED');
  const now = Date.parse(context.now);
  const g = context.grant;
  fail(g && text(g.id) && g.actor === context.actor && g.department === context.department && g.org === state.org && g.target === state.id && g.action === command.action && !g.revoked && Date.parse(g.validFrom) <= now && now < Date.parse(g.validUntil), 'EXACT_GRANT_REQUIRED');
  const p = context.policy;
  fail(p && text(p.id) && text(p.version) && digest(p.digest) && p.revision === context.currentPolicyRevision && Date.parse(p.validFrom) <= now && now < Date.parse(p.validUntil) && !p.hold, 'CURRENT_POLICY_REQUIRED');
  fail(!context.emergencyStop, 'EMERGENCY_STOP');
  if (context.department === 'customer-service') fail(command.action === 'owner-settlement.read', 'CUSTOMER_SERVICE_READ_ONLY');
  if (['owner-settlement.source-version.accept', 'owner-settlement.delivery-package'].includes(command.action)) fail(context.department === 'finance', 'FINANCE_REQUIRED');
  if (command.action !== 'owner-settlement.read') {
    fail(Number.isSafeInteger(command.expectedRevision) && command.expectedRevision === state.revision, 'REVISION_CONFLICT');
    fail(text(command.operationKey), 'OPERATION_KEY_REQUIRED');
    fail(!['__proto__', 'constructor', 'prototype'].includes(command.operationKey), 'RESERVED_OPERATION_KEY');
  }
}

function sourceGuard(version, context) {
  const s = context.sourceAuthority;
  fail(s && text(s.id) && text(s.version) && digest(s.digest) && s.org === context.org && s.target === context.grant.target && s.revision === context.currentSourceRevision && s.system === version.system && s.account === version.account && s.role === 'external-formal-calculator' && s.freshUntil && Date.parse(context.now) < Date.parse(s.freshUntil) && s.conflict === false, 'SOURCE_AUTHORITY_REQUIRED');
}

function approval(command, version, context) {
  fail(['POLICY_GOVERNED', 'APPROVAL_REQUIRED'].includes(context.policy.decisionClass), 'POLICY_DECISION_REQUIRED');
  if (context.policy.decisionClass === 'POLICY_GOVERNED') return;
  const a = context.approval;
  fail(a && text(a.id) && text(a.evidenceRef) && text(a.approver) && (!context.policy.independentApproval || a.approver !== context.actor) && a.org === context.org && a.target === command.id && a.action === command.action && a.sourceVersion === version.sourceVersion && a.sourceDigest === payloadDigest(version) && a.payloadDigest === payloadDigest(command.payload) && a.policyDigest === context.policy.digest && !a.revoked && Date.parse(a.validFrom) <= Date.parse(context.now) && Date.parse(context.now) < Date.parse(a.validUntil), 'EXACT_APPROVAL_REQUIRED');
  fail(context.policy.approvers?.includes(a.approver), 'COMPETENT_APPROVER_REQUIRED');
}

export function execute(state, command, context) {
  guard(state, command, context);
  const input = command.payload ?? {};
  const next = structuredClone(state);
  const fingerprint = payloadDigest({ action: command.action, payload: input });
  const previous = next.operations[command.operationKey];
  if (command.action !== 'owner-settlement.read' && previous) {
    fail(previous.fingerprint === fingerprint, 'OPERATION_KEY_CONFLICT');
    return { state: next, result: structuredClone(previous.result), replay: true };
  }
  let result;
  if (command.action === 'owner-settlement.import') {
    fail(Object.keys(input).every(k => ['system', 'account', 'externalSettlementId', 'sourceVersion', 'beneficiary', 'property', 'mandate', 'period', 'currency', 'document'].includes(k)), 'UNEXPECTED_SOURCE_FIELD');
    for (const k of ['system', 'account', 'externalSettlementId', 'sourceVersion', 'beneficiary', 'property', 'mandate', 'period', 'currency']) fail(text(input[k]), `SOURCE_FIELD_REQUIRED:${k}`);
    fail(input.document && text(input.document.id) && text(input.document.version) && input.document.state === 'USABLE' && digest(input.document.sha256), 'USABLE_ORIGINAL_DOCUMENT_REQUIRED');
    fail(!['__proto__', 'constructor', 'prototype'].includes(input.sourceVersion), 'RESERVED_SOURCE_VERSION');
    sourceGuard(input, context);
    const first = Object.values(next.versions)[0]?.source;
    if (first) for (const k of ['system', 'account', 'externalSettlementId']) fail(first[k] === input[k], 'EXTERNAL_SETTLEMENT_IDENTITY_CONFLICT');
    fail(!next.versions[input.sourceVersion], 'SOURCE_VERSION_EXISTS');
    next.versions[input.sourceVersion] = { source: structuredClone(input), extraction: null, reconciliation: null, reconciliationHistory: [], acceptance: null, delivery: null };
    result = { sourceVersion: input.sourceVersion, status: 'IMPORTED', accepted: false };
  } else {
    const v = next.versions[input.sourceVersion];
    fail(v, 'SOURCE_VERSION_NOT_FOUND');
    sourceGuard(v.source, context);
    if (command.action === 'owner-settlement.read') {
      if (context.department === 'customer-service') {
        fail(v.delivery, 'APPROVED_DELIVERY_REQUIRED');
        return { state: next, result: structuredClone(v.delivery), replay: false };
      }
      return { state: next, result: structuredClone(v), replay: false };
    }
    if (command.action === 'owner-settlement.extract-link') {
      fail(!v.acceptance && !v.extraction, 'IMMUTABLE_EXTRACTION');
      fail(text(input.evidenceRef) && text(input.extractor) && input.documentVersion === v.source.document.version && input.documentSha256 === v.source.document.sha256, 'ATTRIBUTABLE_EXTRACTION_REQUIRED');
      v.extraction = { evidenceRef: input.evidenceRef, extractor: input.extractor, documentVersion: input.documentVersion, documentSha256: input.documentSha256, acceptedFact: false };
      result = structuredClone(v.extraction);
    } else if (command.action === 'owner-settlement.reconcile') {
      fail(!v.acceptance, 'ACCEPTED_VERSION_IMMUTABLE');
      fail(text(input.evidenceRef) && Array.isArray(input.discrepancies) && Array.isArray(input.internalRefs) && input.internalRefs.every(r => ['Charge', 'Payment', 'Allocation', 'JournalTransaction'].includes(r.type) && text(r.id)), 'RECONCILIATION_EVIDENCE_REQUIRED');
      fail(['MATCHED', 'DISCREPANCY', 'UNKNOWN'].includes(input.status), 'RECONCILIATION_STATUS_REQUIRED');
      fail(input.status !== 'MATCHED' || input.discrepancies.length === 0, 'DISCREPANCY_NOT_MATCHED');
      v.reconciliation = { ...structuredClone(input), recordedBy: context.actor };
      v.reconciliationHistory.push(structuredClone(v.reconciliation));
      result = { status: input.status, editsExternalSource: false, postsLedger: false };
    } else if (command.action === 'owner-settlement.source-version.accept') {
      fail(!v.acceptance && v.extraction && v.reconciliation, 'ACCEPTANCE_PREREQUISITES_REQUIRED');
      fail(v.reconciliation.status !== 'UNKNOWN', 'UNKNOWN_BLOCKS_ACCEPTANCE');
      fail(context.policy.reconciliationRuleRef && (v.reconciliation.status === 'MATCHED' || context.policy.acceptDiscrepancy === true), 'DISCREPANCY_POLICY_REQUIRED');
      approval(command, v.source, context);
      v.acceptance = { actor: context.actor, approvalRef: context.policy.decisionClass === 'APPROVAL_REQUIRED' ? context.approval.id : null, sourceAuthorityRef: context.sourceAuthority.id, policyRef: context.policy.id, sourceVersion: input.sourceVersion, originalSha256: v.source.document.sha256 };
      result = { status: 'ACCEPTED_EXTERNAL_VERSION', calculates: false, issues: false, pays: false };
    } else {
      fail(v.acceptance && !v.delivery && text(input.packageId) && text(input.contentRef) && digest(input.contentSha256) && input.recipient === v.source.beneficiary, 'DELIVERY_PACKAGE_SCOPE_REQUIRED');
      approval(command, v.source, context);
      v.delivery = { packageId: input.packageId, sourceVersion: input.sourceVersion, recipient: input.recipient, contentRef: input.contentRef, contentSha256: input.contentSha256, approvalRef: context.policy.decisionClass === 'APPROVAL_REQUIRED' ? context.approval.id : null, dispatchOwner: 'customer-service', sent: false, payout: false };
      result = structuredClone(v.delivery);
    }
  }
  next.revision += 1;
  next.history.push({ revision: next.revision, action: command.action, operationKey: command.operationKey, actor: context.actor, payloadDigest: fingerprint, policy: context.policy.digest, sourceAuthority: context.sourceAuthority.digest });
  next.operations[command.operationKey] = { fingerprint, result: structuredClone(result) };
  return { state: next, result, replay: false };
}
