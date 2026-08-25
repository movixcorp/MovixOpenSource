const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createVavooProxyPolicy,
  isProxyInCidr,
} = require("../vavooProxyPolicy");

function proxy(host, port = 1080) {
  return {
    type: "socks5",
    host,
    port,
  };
}

test("VAVOO bootstraps untested proxies from the preferred /24 first", () => {
  const policy = createVavooProxyPolicy({
    preferredCidrs: ["198.51.100.0/24"],
  });
  const ordinary = proxy("203.0.113.10");
  const preferred = proxy("198.51.100.42");

  assert.equal(isProxyInCidr(preferred, "198.51.100.0/24"), true);
  assert.equal(policy.pick([ordinary, preferred]), preferred);
});

test("VAVOO skips an HTTP 451 proxy for the full legal cooldown", () => {
  let now = 1_000;
  const policy = createVavooProxyPolicy({
    now: () => now,
    preferredCidrs: ["198.51.100.0/24"],
    legalCooldownMs: 10_000,
  });
  const blocked = proxy("198.51.100.10");
  const fallback = proxy("203.0.113.10");

  policy.recordFailure(blocked, 451);
  assert.equal(policy.pick([blocked, fallback]), fallback);

  now += 9_999;
  assert.equal(policy.pick([blocked]), null);

  now += 1;
  assert.equal(policy.pick([blocked]), blocked);
});

test("VAVOO keeps a validated proxy ahead of an untested preferred range", () => {
  let now = 5_000;
  const policy = createVavooProxyPolicy({
    now: () => now,
    preferredCidrs: ["198.51.100.0/24"],
    healthyTtlMs: 60_000,
  });
  const validated = proxy("203.0.113.20");
  const preferred = proxy("198.51.100.20");

  policy.recordSuccess(validated);
  now += 1;

  assert.equal(policy.pick([preferred, validated]), validated);
});

test("VAVOO uses a short cooldown for network failures and retries later", () => {
  let now = 20_000;
  const policy = createVavooProxyPolicy({
    now: () => now,
    networkCooldownMs: 500,
  });
  const candidate = proxy("203.0.113.30");

  policy.recordFailure(candidate);
  assert.equal(policy.pick([candidate]), null);

  now += 500;
  assert.equal(policy.pick([candidate]), candidate);
});
