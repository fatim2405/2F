import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isBlockedAddress, isBlockedHostname } from "./ssrf.js";
import { validateWebhookUrl } from "./create.js";
import { createFetchTransport } from "./transport.js";

test("internal addresses are blocked; public ones are not", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("hooks.example.com"), false);
});

test("production rejects webhook URLs aimed at internal addresses", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x"]) {
    assert.throws(() => validateWebhookUrl(url, prod), /invalid_url|private or internal/, url);
  }
  assert.equal(validateWebhookUrl("https://hooks.example.com/filspay", prod).hostname, "hooks.example.com");
});

test("outside production, local receivers are still allowed", () => {
  assert.equal(validateWebhookUrl("http://localhost:9/receiver", { nodeEnv: "test" }).hostname, "localhost");
});

test("with blocking on, the transport refuses an internal destination without sending", async () => {
  let hit = false;
  const server = createServer((_req, res) => {
    hit = true;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await createFetchTransport({ blockPrivateNetworks: true })({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(res.statusCode, null);
    assert.match(res.errorMessage ?? "", /private or internal/);
    assert.equal(hit, false, "nothing must reach the internal server");
  } finally {
    server.close();
  }
});

test("redirects are not followed, and huge replies are not read in full", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
    } else {
      res.writeHead(200);
      res.end("x".repeat(5 * 1024 * 1024));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const send = createFetchTransport();
  try {
    const redirected = await send({ url: `http://127.0.0.1:${port}/redirect`, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(redirected.statusCode, 302, "a 3xx is returned as-is, never followed");
    const big = await send({ url: `http://127.0.0.1:${port}/big`, headers: {}, body: "{}", timeoutMs: 5000 });
    assert.equal(big.statusCode, 200);
    assert.ok(big.body.length <= 64 * 1024, `read ${big.body.length} bytes`);
  } finally {
    server.close();
  }
});
