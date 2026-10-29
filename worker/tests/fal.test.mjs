import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "../src/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  HF_TOKEN: "hf-test",
  HF_SPACE_BASE: "https://example.hf.space",
  HF_FN_NAME: "generate_video",
  FAL_KEY: "fal-test",
  PRIVATE_ACCESS_KEY: "long-private-access-code",
  ALLOWED_ORIGINS: "https://jaclose.github.io",
  GENERATION_RATE_LIMIT: { limit: async () => ({ success: true }) },
};

function postGeneration(accessKey = env.PRIVATE_ACCESS_KEY) {
  const form = new FormData();
  form.append("image", new File([new Uint8Array([137, 80, 78, 71])], "scene.png", { type: "image/png" }));
  form.append("params", JSON.stringify({ prompt: "A slow camera pan across a mountain landscape", duration_seconds: 3, steps: 30 }));
  return new Request("https://worker.example/fal/generate", {
    method: "POST",
    headers: { Origin: "https://jaclose.github.io", ...(accessKey ? { "X-AXOM-Access-Key": accessKey } : {}) },
    body: form,
  });
}

test("private rendering fails closed without configured provider secrets", async () => {
  const res = await worker.fetch(postGeneration(), { ...env, FAL_KEY: undefined });
  assert.equal(res.status, 503);
});

test("private rendering rejects an invalid access code without calling provider", async () => {
  globalThis.fetch = async () => { throw new Error("Provider must not be contacted"); };
  const res = await worker.fetch(postGeneration("wrong-code"), env);
  assert.equal(res.status, 401);
});

test("paid submission is explicitly authorized and uses the Wan 2.2 queue", async () => {
  let submissions = 0;
  globalThis.fetch = async (url, init) => {
    submissions++;
    assert.equal(String(url), "https://queue.fal.run/fal-ai/wan/v2.2-5b/image-to-video");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Key fal-test");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "A slow camera pan across a mountain landscape");
    assert.equal(body.num_frames, 73);
    assert.match(body.image_url, /^data:image\/png;base64,/);
    return Response.json({ request_id: "a3b84c17-1274-4c3a-81e2-56b906747555" });
  };
  const res = await worker.fetch(postGeneration(), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).requestId, "a3b84c17-1274-4c3a-81e2-56b906747555");
  assert.equal(submissions, 1);
});

test("private status looks up the owner/app queue, not the submission subpath", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://queue.fal.run/fal-ai/wan/requests/a3b84c17-1274-4c3a-81e2-56b906747555/status");
    assert.equal(init.headers.Authorization, "Key fal-test");
    return Response.json({ status: "IN_QUEUE", queue_position: 2 });
  };
  const res = await worker.fetch(new Request(
    "https://worker.example/fal/status?requestId=a3b84c17-1274-4c3a-81e2-56b906747555",
    { headers: { Origin: "https://jaclose.github.io", "X-AXOM-Access-Key": env.PRIVATE_ACCESS_KEY } },
  ), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).queue_position, 2);
});

test("paid result rejects unsafe media destinations", async () => {
  globalThis.fetch = async () => Response.json({ video: { url: "http://169.254.169.254/private.mp4" } });
  const res = await worker.fetch(new Request(
    "https://worker.example/fal/result?requestId=a3b84c17-1274-4c3a-81e2-56b906747555",
    { headers: { Origin: "https://jaclose.github.io", "X-AXOM-Access-Key": env.PRIVATE_ACCESS_KEY } },
  ), env);
  assert.equal(res.status, 502);
});

test("private routes are not accessible from unapproved website origins", async () => {
  globalThis.fetch = async () => { throw new Error("Should not contact provider"); };
  const res = await worker.fetch(new Request(
    "https://worker.example/fal/status?requestId=a3b84c17-1274-4c3a-81e2-56b906747555",
    { headers: { Origin: "https://unapproved.example", "X-AXOM-Access-Key": env.PRIVATE_ACCESS_KEY } },
  ), env);
  assert.equal(res.status, 403);
});
