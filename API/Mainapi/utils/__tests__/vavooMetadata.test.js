const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMetadataIndex,
  createVavooMetadataService,
  findVavooMetadata,
  isHttpsArtworkUrl,
  parseItalyM3u,
  parseTvVooList,
} = require("../vavooMetadata");

test("parses validated non-Italy entries without accepting unsafe artwork", () => {
  const entries = parseTvVooList([
    { name: "TF1 HD", country: "France", logo: "https://img.test/tf1.png", category: "General" },
    { name: "Bad", country: "France", logo: "javascript:alert(1)", category: "Other" },
    { name: "Missing country", logo: "https://img.test/no.png" },
  ]);
  assert.deepEqual(entries, [
    { country: "France", name: "TF1 HD", logo: "https://img.test/tf1.png", category: "General" },
    { country: "France", name: "Bad", logo: null, category: "Other" },
  ]);
  assert.equal(isHttpsArtworkUrl("http://img.test/x.png"), false);
});

test("parses only Italian M3U metadata and ignores stream lines", () => {
  const entries = parseItalyM3u([
    "#EXTM3U",
    '#EXTINF:-1 tvg-logo="https://img.test/rai.png" group-title="RAI",RAI 1 HD',
    "https://untrusted-stream.test/rai.m3u8",
  ].join("\n"));
  assert.deepEqual(entries, [
    { country: "Italy", name: "RAI 1 HD", logo: "https://img.test/rai.png", category: "RAI" },
  ]);
  assert.equal(JSON.stringify(entries).includes("untrusted-stream"), false);
});

test("matches within a country, strips quality tokens, and maps France Sport", () => {
  const index = buildMetadataIndex(parseTvVooList([
    { name: "TF1", country: "France", logo: "https://img.test/tf1.png", category: "General" },
    { name: "TF1", country: "United Kingdom", logo: "https://img.test/uk.png", category: "News" },
  ]));
  assert.equal(findVavooMetadata(index, "France Sport", "TF1 FHD").logo, "https://img.test/tf1.png");
});

test("rejects an ambiguous fuzzy result", () => {
  const index = buildMetadataIndex(parseTvVooList([
    { name: "Canal Sport One", country: "France", logo: "https://img.test/one.png" },
    { name: "Canal Sport Two", country: "France", logo: "https://img.test/two.png" },
  ]));
  assert.equal(findVavooMetadata(index, "France", "Canal Sport"), null);
});

test("rejects colliding exact normalized names", () => {
  const index = buildMetadataIndex(parseTvVooList([
    { name: "M6 HD", country: "France", logo: "https://img.test/m6-a.png" },
    { name: "M6-HD", country: "France", logo: "https://img.test/m6-b.png" },
  ]));
  assert.equal(findVavooMetadata(index, "France", "M6 HD"), null);
});

test("metadata service coalesces a refresh and serves the fresh parsed index", async () => {
  let calls = 0;
  const service = createVavooMetadataService({
    request: async () => {
      calls += 1;
      return { data: [{ name: "TF1", country: "France", logo: "https://img.test/tf1.png" }] };
    },
    readCache: async () => null,
    writeCache: async () => true,
    now: () => 1_000,
  });
  const [left, right] = await Promise.all([
    service.getIndexForGroup("France"),
    service.getIndexForGroup("France Sport"),
  ]);
  assert.equal(calls, 1);
  assert.equal(findVavooMetadata(left, "France", "TF1").logo, "https://img.test/tf1.png");
  assert.equal(left, right);
});

test("metadata service keeps fresh metadata when cache persistence fails", async () => {
  const service = createVavooMetadataService({
    request: async () => ({
      data: [{ name: "France 2", country: "France", logo: "https://img.test/france-2.png" }],
    }),
    readCache: async () => null,
    writeCache: async () => { throw new Error("cache offline"); },
    now: () => 1_000,
    logger: { warn() {} },
  });
  const index = await service.getIndexForGroup("France");
  assert.equal(findVavooMetadata(index, "France", "France 2").logo, "https://img.test/france-2.png");
});

test("metadata service retains last-known-good memory after persistence and refresh failures", async () => {
  let timestamp = 1_000;
  let requests = 0;
  const service = createVavooMetadataService({
    request: async () => {
      requests += 1;
      if (requests === 1) {
        return { data: [{ name: "TF1", country: "France", logo: "https://img.test/tf1.png" }] };
      }
      throw new Error("offline");
    },
    readCache: async () => null,
    writeCache: async () => { throw new Error("cache offline"); },
    now: () => timestamp,
    logger: { warn() {} },
  });

  const fresh = await service.getIndexForGroup("France");
  assert.equal(findVavooMetadata(fresh, "France", "TF1").logo, "https://img.test/tf1.png");

  timestamp += 5 * 60 * 1000 + 1;
  const afterFailedRefresh = await service.getIndexForGroup("France");

  assert.equal(requests, 2);
  assert.equal(findVavooMetadata(afterFailedRefresh, "France", "TF1").logo, "https://img.test/tf1.png");
});

test("metadata service uses last-known-good cache after a refresh failure", async () => {
  const stale = [{ country: "Italy", name: "RAI 1", logo: "https://img.test/rai.png", category: "RAI" }];
  const service = createVavooMetadataService({
    request: async () => { throw new Error("offline"); },
    readCache: async (_key, maxAgeMs) => maxAgeMs > 24 * 60 * 60 * 1000 ? stale : null,
    writeCache: async () => true,
    now: () => 1_000,
    logger: { warn() {} },
  });
  const index = await service.getIndexForGroup("Italy");
  assert.equal(findVavooMetadata(index, "Italy", "RAI 1").category, "RAI");
});
