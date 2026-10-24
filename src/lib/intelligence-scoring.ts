export type ScoreInput = Partial<
	Record<'affinity' | 'philanthropy' | 'connection' | 'recency' | 'geography', number>
>;
export type ScoreWeights = Record<keyof ScoreInput, number>;
export const defaultScoreWeights: ScoreWeights = {
	affinity: 35,
	philanthropy: 25,
	connection: 20,
	recency: 10,
	geography: 10
};
export function scoreProspect(features: ScoreInput, weights: ScoreWeights = defaultScoreWeights) {
	const contributions = Object.entries(weights).map(([feature, weight]) => ({
		feature,
		weight,
		observed: features[feature as keyof ScoreInput] !== undefined,
		contribution:
			features[feature as keyof ScoreInput] === undefined
				? null
				: Math.round(
						Math.max(0, Math.min(1, features[feature as keyof ScoreInput]!)) * weight * 100
					) / 100
	}));
	const coverage = contributions.filter((x) => x.observed).reduce((a, x) => a + x.weight, 0);
	return {
		score: coverage
			? Math.round((contributions.reduce((a, x) => a + (x.contribution || 0), 0) / coverage) * 100)
			: null,
		confidence: coverage / 100,
		contributions,
		explanation:
			'Priority suggestion only. Missing evidence reduces confidence; it is not a judgment of wealth or willingness to give.'
	};
}
