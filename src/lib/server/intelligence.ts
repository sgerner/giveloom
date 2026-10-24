export const introductionStages = [
	'proposed',
	'internal_review',
	'donor_asked',
	'donor_consented',
	'draft_prepared',
	'sent_by_donor',
	'meeting',
	'qualified',
	'donated',
	'closed'
] as const;
export type IntroductionStage = (typeof introductionStages)[number];

/** Enforce a reviewable, sequential introduction flow and explicit donor consent. */
export function validateIntroductionTransition(current: string, next: IntroductionStage) {
	const from = introductionStages.indexOf(current as IntroductionStage);
	const to = introductionStages.indexOf(next);
	if (from < 0 || to < 0 || to !== from + 1)
		throw Object.assign(
			new Error('Introduction stages must advance one reviewed step at a time.'),
			{ status: 422 }
		);
	if (next === 'donor_consented')
		throw Object.assign(
			new Error('The donor must answer this request in their authenticated donor portal.'),
			{ status: 422 }
		);
	return { from: current as IntroductionStage, to: next };
}

export const graphEdgeTypes = [
	'serves_on_board',
	'works_at',
	'trustee_of',
	'grant_to',
	'attended_with',
	'known_by',
	'introduced_by',
	'family_relationship',
	'donor_confirmed_connection',
	'affiliation'
] as const;
export function canViewGraphEvidence(role: string, privacyScope: string) {
	if (privacyScope === 'public_source') return true;
	if (privacyScope === 'tenant') return !['volunteer', 'board_member'].includes(role);
	if (privacyScope === 'restricted') return ['owner', 'admin'].includes(role);
	return false;
}
export function validateGraphEvidence(edge: {
	kind: string;
	evidence: string;
	sourceUrl?: string;
	evidenceType?: string;
}) {
	if (!graphEdgeTypes.includes(edge.kind as (typeof graphEdgeTypes)[number]))
		throw new Error('Choose a supported relationship type.');
	if (!edge.evidence.trim()) throw new Error('Every connection needs a source or evidence note.');
	if (edge.sourceUrl && new URL(edge.sourceUrl).protocol !== 'https:')
		throw new Error('Evidence links must use HTTPS.');
	if (
		edge.kind === 'known_by' ||
		edge.kind === 'family_relationship' ||
		edge.kind === 'donor_confirmed_connection'
	) {
		if (
			edge.evidenceType !== 'donor_confirmed' &&
			(edge.kind === 'family_relationship' || edge.evidenceType !== 'tenant_note')
		)
			throw new Error(
				'A personal relationship needs explicit confirmation or a documented tenant note.'
			);
	}
	return true;
}
