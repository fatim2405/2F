// Checkout load test (k6): each iteration is one customer opening a payment
// link and paying it, the fixed checkout scenario from the brief.
//
//   docker run --rm -i --network ops_default -e BASE_URL=http://api:3000 \
//     -v "$PWD/scripts/loadtest:/lt" grafana/k6:0.54.0 run /lt/checkout.k6.js
//
// "Correct" means: every 200 is a real capture, and anything the API can't
// take right now is turned away with 503 (load shedding), never a 500 or a
// double charge. Latency targets apply to the requests that were accepted.
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const tokens = JSON.parse(open("./tokens.json"));
const paid = new Counter("checkouts_paid");
const shed = new Counter("checkouts_shed_503");
const wrong = new Rate("checkouts_wrong"); // 5xx other than 503, or an unexpected 4xx
const payLatency = new Trend("pay_latency_accepted", true);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { target: 10, duration: "30s" },
        { target: 20, duration: "30s" },
        { target: 30, duration: "30s" },
        { target: 45, duration: "30s" },
        { target: 70, duration: "30s" }, // past the limit on purpose
        { target: 10, duration: "30s" }, // recovery
      ],
    },
  },
  thresholds: {
    checkouts_wrong: ["rate<0.01"],
    pay_latency_accepted: ["p(95)<800"],
  },
};

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

export default function () {
  const token = tokens[exec.scenario.iterationInTest % tokens.length];
  const view = http.get(`${BASE}/v1/payment-links/${token}`, { tags: { step: "view" } });
  if (view.status === 503) { shed.add(1); return; }
  const res = http.post(`${BASE}/v1/payment-links/${token}/pay`, JSON.stringify({ card: CARD }), {
    headers: { "content-type": "application/json", "idempotency-key": `lt-${token}` },
    tags: { step: "pay" },
  });
  if (res.status === 200) {
    paid.add(1);
    payLatency.add(res.timings.duration);
    wrong.add(false);
  } else if (res.status === 503) {
    shed.add(1);
    wrong.add(false);
  } else {
    wrong.add(true);
  }
  check(res, { "paid or cleanly shed": (r) => r.status === 200 || r.status === 503 });
}
