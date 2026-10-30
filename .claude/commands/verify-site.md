---
description: Check the real websites in a fresh browser, not just the API
---
Open `/dashboard/login` and the admin `/login` in a new browser with no cookies,
sign in, and look at the page and the console. Run `scripts/demo/refund-demo.js`
for the full and partial refund path. A passing test suite does not prove the
site works: the dev proxy bug was only visible in a fresh browser.
