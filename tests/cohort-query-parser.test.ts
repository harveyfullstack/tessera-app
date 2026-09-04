import { describe, expect, test } from "bun:test";
import { parseCohortQuery } from "../src/application/cohort-query-parser";

describe("parseCohortQuery — pre-delivery characterization", () => {
  test("parses an explicit known field and value", () => {
    expect(parseCohortQuery("customers on the enterprise plan")).toEqual({
      sourceText: "customers on the enterprise plan",
      filters: [{ field: "plan", operator: "equals", value: "enterprise" }],
      grounding: { required: false, terms: [] },
    });
  });

  test("accepts an ambiguous business term as a permissive filter", () => {
    expect(parseCohortQuery("high value customers")).toEqual({
      sourceText: "high value customers",
      filters: [{ field: "business_term", operator: "equals", value: "high value" }],
      grounding: { required: false, terms: ["high value"] },
    });
    // Post-delivery gap: determine whether "high value" means revenue, LTV, or another grounded definition.
  });

  test("accepts an unknown business term instead of requiring grounding", () => {
    expect(parseCohortQuery("customers in the moonshot segment")).toEqual({
      sourceText: "customers in the moonshot segment",
      filters: [{ field: "business_term", operator: "equals", value: "moonshot" }],
      grounding: { required: false, terms: ["moonshot"] },
    });
    // Post-delivery gap: reject or resolve terms that are absent from the business vocabulary.
  });
});
