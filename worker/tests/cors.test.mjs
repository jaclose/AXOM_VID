import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const env = {
  ALLOWED_ORIGINS: "http://localhost:4321,https://jaclose.github.io",
  HF_SPACE_BASE: "https://example.hf.space",
  HF_FN_NAME: "generate_video",
  HF_TOKEN: "hf-placeholder-not-a-real-token",
};

function preflight(origin) {
  return worker.fetch(new Request("https://worker.example/generate", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  }), env);
}

test("local AXOM_VID browsers on the known port range can complete CORS preflight", async () => {
  for (const port of [8765, 8766, 8767, 8770, 8775]) {
    for (const host of ["127.0.0.1", "localhost"]) {
      const origin = `http://${host}:${port}`;
      const res = await preflight(origin);
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
      assert.match(res.headers.get("Access-Control-Allow-Methods") || "", /POST/);
    }
  }
});

test("the configured GitHub Pages site remains allowed", async () => {
  const origin = "https://jaclose.github.io";
  const res = await preflight(origin);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
});

test("unknown or spoofed localhost origins remain disallowed", async () => {
  for (const origin of [
    "http://127.0.0.1:8776",
    "http://localhost:8764",
    "http://127.0.0.1.attacker.example:8765",
    "http://another.localhost:8765",
    "https://127.0.0.1:8765",
    "http://127.0.0.1:8765.attacker.example",
    "http://127.0.0.1:4321",
  ]) {
    const res = await preflight(origin);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null, origin);
  }
});

test("local shared GPU quota and configuration routes are readable by allowed browser origins", async () => {
  const origin = "http://127.0.0.1:8765";
  const res = await worker.fetch(new Request("https://worker.example/health", {
    headers: { Origin: origin },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
  const data = await res.json();
  assert.equal(data.configured, true);
  assert.equal(data.HF_TOKEN, undefined);
});
