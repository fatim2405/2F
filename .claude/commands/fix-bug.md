---
description: Fix one bug with proof, following the team's rules
argument-hint: <bug description>
---
Bug: $ARGUMENTS

1. Reproduce it or find the exact code. A report from a sub-agent is a lead, not a fact.
2. Check `docs/ARCHITECTURE.md` and the ADRs: it may be intentional.
3. Write a new `*.new.test.ts` or `*_new_test.go` test first, and show it fails on the old code.
4. Make the smallest fix. Never touch `packages/money` or an existing test.
5. Run `/test-all`.
6. Add the bug to `docs/FINDINGS.md`: symptom, root cause, fix, proof, effect on existing data.
