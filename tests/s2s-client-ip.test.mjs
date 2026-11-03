import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIpNetwork, requestClientIp } from "../lib/s2s-client-ip.mjs";

test("normalizes host addresses to exact CIDR networks", () => {
  assert.equal(normalizeIpNetwork("203.0.113.8"), "203.0.113.8/32");
  assert.equal(normalizeIpNetwork("2001:db8::1"), "2001:db8::1/128");
  assert.equal(normalizeIpNetwork("203.0.113.0/24"), "203.0.113.0/24");
});

test("rejects malformed IP and prefix values", () => {
  for (const value of ["", "hostname", "203.0.113.1/33", "2001:db8::1/129", "1.2.3.4/1/2"]) {
    assert.equal(normalizeIpNetwork(value), null);
  }
});

test("uses only Vercel's forwarded client address and rejects ambiguous chains", () => {
  assert.equal(
    requestClientIp({ headers: { "x-forwarded-for": "203.0.113.9" } }, { VERCEL: "1" }),
    "203.0.113.9"
  );
  assert.equal(
    requestClientIp({ headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }, { VERCEL: "1" }),
    null
  );
  assert.equal(
    requestClientIp({ headers: { "x-forwarded-for": "203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } }, {}),
    "127.0.0.1"
  );
});
