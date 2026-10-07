import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, emptyState, payloadDigest, actions } from '../skills/woia-re-owner-settlement/scripts/settlement.mjs';

const hash = 'a'.repeat(64);
const source = { system: 'synthetic-admin', account: 'account-1', externalSettlementId: 'external-1', sourceVersion: 'v1', beneficiary: 'owner-1', property: 'property-1', mandate: 'mandate-1', period: '2026-10', currency: 'XXX', document: { id: 'doc-1', version: 'dv1', state: 'USABLE', sha256: hash } };
function ctx(action, department = 'finance') {
  return { actor: 'actor-1', task: 'task-1', org: 'org-1', department, now: '2026-10-07T12:00:00Z', currentPolicyRevision: 1, currentSourceRevision: 1,
    grant: { id: 'grant-1', actor: 'actor-1', department, org: 'org-1', target: 's1', action, validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' },
    policy: { id: 'policy-1', version: '1', digest: hash, revision: 1, validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', decisionClass: 'APPROVAL_REQUIRED', independentApproval: true, approvers: ['finance-reviewer'], reconciliationRuleRef: 'synthetic-matching-rule' },
    originalDocument: { org: 'org-1', ...source.document },
    resolvedReferences: { beneficiary: { org: 'org-1', id: source.beneficiary, state: 'ACCEPTED' }, property: { org: 'org-1', id: source.property, state: 'ACCEPTED' }, mandate: { org: 'org-1', id: source.mandate, state: 'ACCEPTED' } },
    sourceAuthority: { id: 'map-1', version: '1', digest: hash, revision: 1, org: 'org-1', target: 's1', system: source.system, account: source.account, role: 'external-formal-calculator', effectiveFrom: '2026-10-01T00:00:00Z', freshUntil: '2026-11-01T00:00:00Z', conflict: false } };
}
function cmd(action, state, payload) { return { action: `owner-settlement.${action}`, org: 'org-1', id: 's1', expectedRevision: state.revision, operationKey: `${action}-${state.revision}`, payload }; }
function run(state, action, payload, customize = () => {}) {
  const command = cmd(action, state, payload); const context = ctx(command.action); customize(context, command);
  return execute(state, command, context);
}
const imported = () => run(emptyState('org-1', 's1'), 'import', source).state;
function approval(c, command) { c.approval = { id: 'approval-1', evidenceRef: 'authority-evidence-1', approver: 'finance-reviewer', org: 'org-1', target: 's1', action: command.action, sourceVersion: 'v1', sourceDigest: payloadDigest(source), payloadDigest: payloadDigest(command.payload), policyDigest: hash, validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' }; }
function prepared() {
  let s = imported();
  s = run(s, 'extract-link', { sourceVersion: 'v1', evidenceRef: 'extraction-1', extractor: 'synthetic-extractor', documentVersion: 'dv1', documentSha256: hash }).state;
  return run(s, 'reconcile', { sourceVersion: 'v1', evidenceRef: 'reconcile-1', status: 'MATCHED', discrepancies: [], internalRefs: [{ type: 'Charge', id: 'charge-1' }] }).state;
}
test('external version lifecycle keeps original evidence immutable; package is not sending or payout', () => {
  const initial = prepared(); const s = run(initial, 'source-version.accept', { sourceVersion: 'v1' }, approval).state;
  const delivered = run(s, 'delivery-package', { sourceVersion: 'v1', packageId: 'package-1', contentRef: 'document-2', contentSha256: hash, recipient: 'owner-1' }, approval);
  assert.equal(delivered.result.sent, false); assert.equal(delivered.result.payout, false);
  assert.deepEqual(delivered.state.versions.v1.source, source);
  assert.equal(delivered.state.versions.v1.extraction.acceptedFact, false);
  const c = cmd('read', delivered.state, { sourceVersion: 'v1' });
  assert.equal(execute(delivered.state, c, ctx(c.action, 'customer-service')).result.dispatchOwner, 'customer-service');
  assert.equal(initial.versions.v1.acceptance, null);
});
for (const [name, change] of [
  ['wrong org', c => { c.org = 'other'; }], ['wrong target', c => { c.grant.target = 'other'; }], ['wrong action', c => { c.grant.action = 'owner-settlement.calculate'; }],
  ['revoked', c => { c.grant.revoked = true; }], ['expired', c => { c.grant.validUntil = c.now; }], ['policy drift', c => { c.currentPolicyRevision = 2; }],
  ['source drift', c => { c.currentSourceRevision = 2; }], ['source conflict', c => { c.sourceAuthority.conflict = true; }], ['source stale', c => { c.sourceAuthority.freshUntil = c.now; }],
  ['external system mismatch', c => { c.sourceAuthority.system = 'wrong'; }], ['hold', c => { c.policy.hold = true; }], ['stop', c => { c.emergencyStop = true; }],
]) test(`fail closed: ${name}`, () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', source, change)));
test('CAS blocks stale revision and preserves state', () => { const s = imported(); assert.throws(() => run(s, 'extract-link', {}, (_, command) => { command.expectedRevision = 0; }), /REVISION/); assert.equal(s.revision, 1); });
test('stable operation replay, key collision rejected', () => {
  const s = imported(); const c = cmd('import', s, source); c.operationKey = 'import-0';
  assert.equal(execute(s, c, ctx(c.action)).replay, true);
  c.payload = { ...source, beneficiary: 'other' }; assert.throws(() => execute(s, c, ctx(c.action)), /OPERATION_KEY_CONFLICT/);
});
test('unusable original document blocked', () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', { ...source, document: { ...source.document, state: 'PENDING' } }), /USABLE/));
test('source duplicate is not overwritten', () => assert.throws(() => run(imported(), 'import', { ...source, property: 'different' }), /SOURCE_VERSION_EXISTS/));
test('extraction alone never accepts', () => assert.throws(() => run(imported(), 'source-version.accept', { sourceVersion: 'v1' }, approval), /PREREQUISITES/));
test('different original hash cannot link extraction', () => assert.throws(() => run(imported(), 'extract-link', { sourceVersion: 'v1', evidenceRef: 'e', extractor: 'x', documentVersion: 'dv1', documentSha256: 'b'.repeat(64) }), /EXTRACTION/));
test('unknown reconciliation blocks acceptance', () => { let s = prepared(); s = run(s, 'reconcile', { sourceVersion: 'v1', evidenceRef: 'new', status: 'UNKNOWN', discrepancies: [], internalRefs: [] }).state; assert.throws(() => run(s, 'source-version.accept', { sourceVersion: 'v1' }, approval), /UNKNOWN/); });
test('discrepancy stays discrepancy unless exact accepted policy allows it', () => {
  let s = prepared(); s = run(s, 'reconcile', { sourceVersion: 'v1', evidenceRef: 'diff', status: 'DISCREPANCY', discrepancies: ['difference-ref'], internalRefs: [] }).state;
  assert.throws(() => run(s, 'source-version.accept', { sourceVersion: 'v1' }, approval), /DISCREPANCY_POLICY/);
  const a = run(s, 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { c.policy.acceptDiscrepancy = true; approval(c, command); });
  assert.equal(a.state.versions.v1.reconciliation.status, 'DISCREPANCY');
});
for (const action of ['calculate', 'issue', 'payout', 'send']) test(`no ${action} capability`, () => assert.throws(() => run(imported(), action, { sourceVersion: 'v1' }), /ACTION_FORBIDDEN/));
test('acceptance only Finance', () => assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { c.department = c.grant.department = 'asset-management'; approval(c, command); }), /FINANCE/));
for (const [name, mutate] of [ ['changed payload', a => { a.payloadDigest = 'b'.repeat(64); }], ['revoked', a => { a.revoked = true; }], ['self approval', a => { a.approver = 'actor-1'; }], ['unqualified approver', a => { a.approver = 'other'; }], ['wrong version', a => { a.sourceVersion = 'v2'; }], ['expired', a => { a.validUntil = '2026-10-07T12:00:00Z'; }] ]) test(`approval ${name} denied`, () => assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { approval(c, command); mutate(c.approval); })));
test('Customer Service cannot read unapproved source or mutate', () => { const s = imported(); const c = cmd('read', s, { sourceVersion: 'v1' }); assert.throws(() => execute(s, c, ctx(c.action, 'customer-service')), /APPROVED_DELIVERY/); assert.throws(() => run(s, 'reconcile', {}, c => { c.department = c.grant.department = 'customer-service'; }), /READ_ONLY/); });
test('accepted version cannot be edited by reconciliation', () => { const s = run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, approval).state; assert.throws(() => run(s, 'reconcile', { sourceVersion: 'v1' }), /IMMUTABLE/); });
test('exact supported action surface', () => assert.equal(actions.length, 6));
test('new version cannot change stable external settlement identity', () => {
  for (const k of ['system', 'account', 'externalSettlementId']) assert.throws(() => run(imported(), 'import', { ...source, sourceVersion: 'v2', [k]: 'other' }, c => { c.sourceAuthority[k] = 'other'; }));
});
test('reconciliation history retains full attributed evidence', () => {
  const s = prepared(); const n = run(s, 'reconcile', { sourceVersion: 'v1', evidenceRef: 'different', status: 'DISCREPANCY', discrepancies: ['d1'], internalRefs: [] }).state;
  assert.equal(n.versions.v1.reconciliationHistory.length, 2);
  assert.equal(n.versions.v1.reconciliationHistory[0].evidenceRef, 'reconcile-1');
  assert.equal(n.versions.v1.reconciliationHistory[1].recordedBy, 'actor-1');
});
test('policy-governed acceptance does not require invented approval', () => {
  const n = run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, c => { c.policy.decisionClass = 'POLICY_GOVERNED'; }).state;
  assert.equal(n.versions.v1.acceptance.approvalRef, null);
});
test('delivery binds beneficiary and original source digest', () => {
  const s = run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, approval).state;
  assert.throws(() => run(s, 'delivery-package', { sourceVersion: 'v1', packageId: 'p', contentRef: 'd', contentSha256: hash, recipient: 'other' }, approval), /SCOPE/);
  assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { approval(c, command); c.approval.sourceDigest = 'b'.repeat(64); }), /APPROVAL/);
});
test('future source map is denied', () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', source, c => { c.sourceAuthority.effectiveFrom = '2026-10-08T00:00:00Z'; }), /SOURCE_AUTHORITY/));
test('revoked source map is denied', () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', source, c => { c.sourceAuthority.revoked = true; }), /SOURCE_AUTHORITY/));
for (const field of ['org', 'id', 'version', 'sha256', 'state']) test(`resolved document ${field} mismatch denied`, () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', source, c => { c.originalDocument[field] = 'different'; }), /RESOLVED_ORIGINAL/));
test('command document is not independent verification', () => assert.throws(() => run(emptyState('org-1', 's1'), 'import', source, c => { delete c.originalDocument; }), /RESOLVED_ORIGINAL/));
for (const kind of ['beneficiary', 'property', 'mandate']) {
  test(`acceptance needs resolved ${kind}`, () => assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { approval(c, command); delete c.resolvedReferences[kind]; }), /RESOLVED_REFERENCE/));
  test(`acceptance rejects cross-org ${kind}`, () => assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { approval(c, command); c.resolvedReferences[kind].org = 'other'; }), /RESOLVED_REFERENCE/));
  test(`acceptance rejects wrong ${kind}`, () => assert.throws(() => run(prepared(), 'source-version.accept', { sourceVersion: 'v1' }, (c, command) => { approval(c, command); c.resolvedReferences[kind].id = 'other'; }), /RESOLVED_REFERENCE/));
}
