---
description: Measure capacity on a separate database, under the real CPU limits
argument-hint: [checkouts per second]
---
Follow "Reproducing the measurement" in `docs/CAPACITY.md`. Limit BOTH the API
(0.5 vCPU / 512 MB) and Postgres (0.30 vCPU / 640 MB): a number measured with
Postgres unlimited is not a capacity figure. Use a separate `filspay_loadtest`
database, never `filspay`. Pass `RATE=$ARGUMENTS` for a steady rate. Afterwards
check paid links = captured transactions and that every ledger group balances.
