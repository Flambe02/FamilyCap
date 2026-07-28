import { test } from "node:test";
import assert from "node:assert/strict";
import { isChallengeEligible, toFamilyRole } from "../lib/auth-types.ts";

test("les défis sont visibles pour chaque profil familial, y compris Amatxi en lecture seule", () => {
  for (const role of ["admin", "adult", "child", "viewer", "member", null, "inconnu"]) {
    assert.equal(isChallengeEligible(role), true, `défis invisibles pour ${String(role)}`);
  }
  assert.equal(toFamilyRole("viewer"), "viewer");
});
