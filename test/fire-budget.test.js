import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DISPATCH_ATTEMPTS, readDispatchConfig, readFireBudget, readIntakeRole } from "../tasks.js";

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

test("SQL intake role: only valid lowercase Postgres role names enable the intake", () => {
  assert.equal(readIntakeRole({}), null);
  assert.equal(readIntakeRole({ GAIA_SQL_INTAKE_ROLE: "gaia_chatgpt_intake" }), "gaia_chatgpt_intake");
  for (const bad of ["", "Gaia", "1abc", "a b", "x;drop", "a".repeat(64)]) {
    assert.equal(readIntakeRole({ GAIA_SQL_INTAKE_ROLE: bad }), null, `disabled for ${JSON.stringify(bad)}`);
  }
  assert.equal(readDispatchConfig({}).intakeRole, null);
});
