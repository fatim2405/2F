// Real refund demo on localhost: two new payments, one partial and one full refund through the
// dashboard, then today's settlement batch and reconciliation. Saves screenshots and the numbers.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const WEB = "http://localhost:5173", ADMIN = "http://localhost:5174", API = "http://localhost:3000";
const ALPHA = "9972daab-2c86-459f-9d78-3fe1be4e3280";
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 27 * 3600e3).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const facts = { today };

async function setInput(page, el, value) {
  await page.evaluate((input, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, el, value);
}
async function byLabel(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll("label")].some((x) => x.textContent.trim().startsWith(t)), { timeout: 15000 }, text);
  const h = await page.evaluateHandle((t) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(t));
    return l && l.querySelector("input");
  }, text);
  if (!h.asElement()) throw new Error(`no input "${text}"`);
  return h.asElement();
}
const clickText = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
  if (!b) throw new Error("no button " + t);
  b.click();
}, text);
async function shot(page, name) {
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
  console.log("saved", name);
}
async function otp(page) {
  await page.waitForFunction(() => /Development code/i.test(document.body.innerText), { timeout: 15000 });
  const code = await page.evaluate(() => [...document.querySelectorAll("code")].map((c) => c.textContent.trim()).find((t) => /^\d{4,8}$/.test(t)));
  await setInput(page, await byLabel(page, "One-time code"), code);
  await page.evaluate(() => document.querySelector('form button[type="submit"]').click());
  await sleep(1500);
}
const api = (page, method, url, body, headers = {}) => page.evaluate(async (method, url, body, headers) => {
  const r = await fetch(url, { method, credentials: "include", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, method, url, body, headers);

async function payNew(page, amountFils, reference) {
  const expiresAt = new Date(Date.now() + 3600e3).toISOString();
  const link = await api(page, "POST", `${API}/v1/merchants/${ALPHA}/payment-links`, { amountFils, reference, expiresAt }, { "idempotency-key": crypto.randomUUID() });
  if (link.status !== 201) throw new Error("create link: " + JSON.stringify(link));
  for (let i = 0; i < 5; i++) {
    const pay = await api(page, "POST", `${API}/v1/payment-links/${link.body.token}/pay`, { card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }, { "idempotency-key": crypto.randomUUID() });
    if (pay.status === 200) return pay.body.transactionId ?? (await api(page, "GET", `${API}/v1/merchants/${ALPHA}/payment-links?limit=1`)).body.paymentLinks[0].transactionId;
    console.log("pay retry", pay.status);
  }
  throw new Error("could not pay " + reference);
}
async function refundViaDrawer(page, txnId, amountBd, name) {
  await page.goto(`${WEB}/dashboard/transactions/${txnId}`, { waitUntil: "networkidle0" });
  await clickText(page, "Refund");
  await sleep(300);
  if (amountBd) await setInput(page, await byLabel(page, "Amount in BD"), amountBd);
  await shot(page, `${name}-a-refund-form`);
  await page.evaluate(() => [...document.querySelectorAll("form button")].find((b) => b.textContent.trim() === "Refund").click());
  await sleep(2500);
  await shot(page, `${name}-b-after-refund`);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 860 });
    page.on("dialog", (d) => d.accept());
    await page.goto(`${WEB}/dashboard/login`, { waitUntil: "networkidle0" });
    await setInput(page, await byLabel(page, "Email"), "owner@alpharetail.example");
    await setInput(page, await byLabel(page, "Password"), "FilsPaySeed!2026");
    await page.evaluate(() => document.querySelector('form button[type="submit"]').click());
    await page.waitForFunction(() => /Which one do you want to open/i.test(document.body.innerText), { timeout: 15000 });
    await clickText(page, "Alpha Retail Co");
    await otp(page);

    const partialTxn = await payNew(page, 50000, "demo-partial-refund");
    const fullTxn = await payNew(page, 20000, "demo-full-refund");
    facts.partialTxn = partialTxn; facts.fullTxn = fullTxn;

    await refundViaDrawer(page, partialTxn, "15.000", "demo-1-partial");
    await refundViaDrawer(page, fullTxn, "", "demo-2-full");
    facts.partialAfter = (await api(page, "GET", `${API}/v1/transactions/${partialTxn}`)).body;
    facts.fullAfter = (await api(page, "GET", `${API}/v1/transactions/${fullTxn}`)).body;

    // Admin closes today's batch for this merchant.
    const adminPage = await browser.newPage();
    await adminPage.setViewport({ width: 1366, height: 860 });
    await adminPage.goto(`${ADMIN}/login`, { waitUntil: "networkidle0" });
    await setInput(adminPage, await byLabel(adminPage, "Email"), "superadmin@filspay.test");
    await setInput(adminPage, await byLabel(adminPage, "Password"), "FilsPayAdminSeed!2026");
    await adminPage.evaluate(() => document.querySelector('form button[type="submit"]').click());
    await otp(adminPage);
    const run = await api(adminPage, "POST", `${API}/v1/admin/settlement/run-batch`, { date: today, merchantId: ALPHA });
    facts.runBatch = run;
    console.log("run-batch", run.status, JSON.stringify(run.body).slice(0, 300));
    await adminPage.close();

    // Merchant views: settlement list, batch detail, reconciliation.
    const list = await api(page, "GET", `${API}/v1/settlement/batches?limit=5`);
    const batches = list.body.batches ?? list.body.items ?? list.body;
    const batch = (Array.isArray(batches) ? batches : []).find((b) => b.batchDate === today);
    facts.batch = batch ?? null;
    await page.goto(`${WEB}/dashboard/settlement`, { waitUntil: "networkidle0" });
    await shot(page, "demo-3-settlement-list");
    if (batch) {
      await page.goto(`${WEB}/dashboard/settlement/${batch.id}`, { waitUntil: "networkidle0" });
      await shot(page, "demo-4-settlement-batch");
    }
    facts.reconciliation = (await api(page, "GET", `${API}/v1/settlement/reconciliation?from=${today}&to=${tomorrow}`)).body;
    await page.goto(`${WEB}/dashboard/reconciliation`, { waitUntil: "networkidle0" });
    await shot(page, "demo-5-reconciliation");
    await page.goto(`${WEB}/dashboard/transactions`, { waitUntil: "networkidle0" });
    await shot(page, "demo-6-transactions");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, "demo-facts.json"), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ partial: { s: facts.partialAfter?.status, c: facts.partialAfter?.capturedFils, r: facts.partialAfter?.refundedFils }, full: { s: facts.fullAfter?.status, c: facts.fullAfter?.capturedFils, r: facts.fullAfter?.refundedFils }, batch: facts.batch, recon: facts.reconciliation }, null, 1));
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
