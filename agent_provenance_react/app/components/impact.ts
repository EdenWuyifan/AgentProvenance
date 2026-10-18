export type PresenceFeature = {
  id: string;
  supportIds: string[];
};

export type PresenceSample = {
  id: string;
  score: number;
};

export type PresenceImpact = {
  id: string;
  usageCount: number;
  impact: number;
  impactAbs: number;
  meanPresentScore: number | null;
  meanAbsentScore: number | null;
};

function mean(values: number[]) {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function solveLinearSystem(matrix: number[][], vector: number[]) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
    let pivotRow = pivotIndex;

    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex += 1) {
      if (
        Math.abs(augmented[rowIndex][pivotIndex])
        > Math.abs(augmented[pivotRow][pivotIndex])
      ) {
        pivotRow = rowIndex;
      }
    }

    if (pivotRow !== pivotIndex) {
      [augmented[pivotIndex], augmented[pivotRow]] = [
        augmented[pivotRow],
        augmented[pivotIndex],
      ];
    }

    const pivot = augmented[pivotIndex][pivotIndex];
    if (Math.abs(pivot) < 1e-9) {
      return Array<number>(size).fill(0);
    }

    for (let columnIndex = pivotIndex; columnIndex <= size; columnIndex += 1) {
      augmented[pivotIndex][columnIndex] /= pivot;
    }

    for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
      if (rowIndex === pivotIndex) {
        continue;
      }

      const factor = augmented[rowIndex][pivotIndex];
      for (let columnIndex = pivotIndex; columnIndex <= size; columnIndex += 1) {
        augmented[rowIndex][columnIndex] -=
          factor * augmented[pivotIndex][columnIndex];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

export function calculatePresenceImpacts(
  features: PresenceFeature[],
  samples: PresenceSample[]
): PresenceImpact[] {
  if (features.length === 0 || samples.length === 0) {
    return [];
  }

  const supportByFeature = features.map((feature) => new Set(feature.supportIds));
  const rows = samples.map((sample) =>
    supportByFeature.map((supportIds) => (supportIds.has(sample.id) ? 1 : 0))
  );
  const scores = samples.map((sample) => sample.score);
  const featureMeans = features.map(
    (_, featureIndex) =>
      rows.reduce((total, row) => total + row[featureIndex], 0) / rows.length
  );
  const scoreMean = mean(scores) ?? 0;
  const gram = Array.from({ length: features.length }, () =>
    Array<number>(features.length).fill(0)
  );
  const rhs = Array<number>(features.length).fill(0);

  rows.forEach((row, rowIndex) => {
    const centeredScore = scores[rowIndex] - scoreMean;
    const centeredRow = row.map(
      (value, featureIndex) => value - featureMeans[featureIndex]
    );

    centeredRow.forEach((value, leftIndex) => {
      rhs[leftIndex] += value * centeredScore;

      for (let rightIndex = leftIndex; rightIndex < features.length; rightIndex += 1) {
        gram[leftIndex][rightIndex] += value * centeredRow[rightIndex];
      }
    });
  });

  gram.forEach((row, leftIndex) => {
    for (let rightIndex = leftIndex + 1; rightIndex < features.length; rightIndex += 1) {
      gram[rightIndex][leftIndex] = row[rightIndex];
    }
    row[leftIndex] += 1;
  });

  const coefficients = solveLinearSystem(gram, rhs);

  return features.map((feature, featureIndex) => {
    const presentScores: number[] = [];
    const absentScores: number[] = [];
    let absoluteContributionSum = 0;

    rows.forEach((row, rowIndex) => {
      const present = row[featureIndex] === 1;
      const contribution =
        coefficients[featureIndex] * (row[featureIndex] - featureMeans[featureIndex]);

      absoluteContributionSum += Math.abs(contribution);
      (present ? presentScores : absentScores).push(scores[rowIndex]);
    });

    const impactAbs = absoluteContributionSum / rows.length;
    const direction = Math.sign(coefficients[featureIndex] || 0);

    return {
      id: feature.id,
      usageCount: presentScores.length,
      impact: direction * impactAbs,
      impactAbs,
      meanPresentScore: mean(presentScores),
      meanAbsentScore: mean(absentScores),
    };
  });
}
