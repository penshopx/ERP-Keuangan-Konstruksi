import assert from "node:assert/strict";
import test from "node:test";
import {
  currentOperationalDate,
  currentOperationalMonth,
  OPERATIONAL_TIME_ZONE,
} from "./operational-calendar";

test("uses the explicit Indonesian operational time zone", () => {
  assert.equal(OPERATIONAL_TIME_ZONE, "Asia/Jakarta");
});

test("changes operational date when Jakarta has crossed midnight but UTC has not", () => {
  const now = new Date("2031-01-15T17:00:00.000Z");

  assert.equal(currentOperationalDate(now), "2031-01-16");
  assert.equal(now.toISOString().slice(0, 10), "2031-01-15");
});

test("changes operational month when Jakarta has crossed month end but UTC has not", () => {
  const now = new Date("2031-01-31T17:00:00.000Z");

  assert.equal(currentOperationalDate(now), "2031-02-01");
  assert.equal(currentOperationalMonth(now), "2031-02");
  assert.equal(now.toISOString().slice(0, 7), "2031-01");
});