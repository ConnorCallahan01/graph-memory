/**
 * Somatic marker module — emotional/intensity weighting for search relevance.
 * Nodes with higher soma intensity get a boost in search results,
 * modeling how emotionally significant memories are more easily recalled.
 */

export interface SomaMarker {
  valence: string; // e.g. "positive", "negative", "neutral"
  intensity: number; // 0.0 to 1.0
  marker: string; // short label e.g. "curiosity", "frustration"
}

/**
 * Calculate a relevance multiplier based on somatic intensity.
 * intensity 0 → 1.0x (no boost)
 * intensity 1.0 → 1.3x (max boost)
 */
export function somaBoost(intensity: number): number {
  return 1.0 + (Math.max(0, Math.min(1, intensity)) * 0.3);
}

/**
 * Format a soma marker for display in search results.
 */
export function formatSoma(soma?: SomaMarker): string {
  if (!soma) return "";
  return `soma: ${soma.marker} (${soma.valence}, ${soma.intensity.toFixed(1)})`;
}
