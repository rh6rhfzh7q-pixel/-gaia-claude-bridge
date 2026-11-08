import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DISPATCH_ATTEMPTS, readDispatchConfig, readFireBudget } from "../tasks.js";

test("fire budget: unset means normal operation, valid values limit attempts, anything else fails closed", () => {
  assert.equal(readFireBudget({}), null);
  assert.equal(readFireBudget({ GAIA_DISPATCH_FIRE_BUDGET: "" }), null);
  assert.equal(readFireBudget({ GAIA_DISPATCH_FIRE_BUDGET: "1" }), 1);
  assert.equal(readFireBudget({ GAIA_DISPATCH_FIRE_BUDGET: "100" }), 100);
  for (const bad of ["0", "101", "-1", "1.5", "eins", " 1", "1e1"]) {
    assert.equal(readFireBudget({ GAIA_DISPATCH_FIRE_BUDGET: bad }), 0, `fail closed for ${JSON.stringify(bad)}`);
  }
  assert.equal(readDispatchConfig({}).maxAttempts, MAX_DISPATCH_ATTEMPTS);
  assert.equal(readDispatchConfig({ GAIA_DISPATCH_FIRE_BUDGET: "1" }).maxAttempts, 1);
  assert.equal(readDispatchConfig({ GAIA_DISPATCH_FIRE_BUDGET: "x" }).maxAttempts, 1);
});
