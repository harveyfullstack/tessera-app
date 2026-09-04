export interface CohortFilter {
  field: string;
  operator: "equals";
  value: string;
}

export interface CohortQuery {
  sourceText: string;
  filters: CohortFilter[];
  grounding: {
    required: boolean;
    terms: string[];
  };
}

interface KnownCohort {
  pattern: RegExp;
  filter: CohortFilter;
}

const KNOWN_COHORTS: readonly KnownCohort[] = [
  { pattern: /\benterprise plan\b/i, filter: { field: "plan", operator: "equals", value: "enterprise" } },
  { pattern: /\bactive customers?\b/i, filter: { field: "lifecycle", operator: "equals", value: "active" } },
];

export function parseCohortQuery(sourceText: string): CohortQuery {
  const knownCohort = KNOWN_COHORTS.find(({ pattern }) => pattern.test(sourceText));

  if (knownCohort) {
    return { sourceText, filters: [knownCohort.filter], grounding: { required: false, terms: [] } };
  }

  const term = sourceText
    .toLowerCase()
    .replace(/\b(?:show|find|target|send to|customers?|accounts?|users?)\b/g, " ")
    .replace(/^(?:\s*(?:in|on|with|from)\s+(?:the\s+)?)/, "")
    .replace(/\s+(?:segment|cohort)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    sourceText,
    filters: term ? [{ field: "business_term", operator: "equals", value: term }] : [],
    grounding: { required: false, terms: term ? [term] : [] },
  };
}
