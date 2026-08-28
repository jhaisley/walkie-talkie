import { describe, expect, it } from "vitest";
import { isReservedName } from "../server.js";

describe("reserved callsigns", () => {
  it("reserves operator in any casing or padding", () => {
    for (const n of ["operator", "Operator", "OPERATOR", "  operator  "]) {
      expect(isReservedName(n)).toBe(true);
    }
  });

  it("does not reserve ordinary names, including ones containing it", () => {
    for (const n of ["alice", "operator-2", "the-operator", "op", ""]) {
      expect(isReservedName(n)).toBe(false);
    }
  });
});
