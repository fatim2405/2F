---
description: Run the full test suite on fresh databases and report it honestly
---
Run `bash ops/run-tests.sh` (TypeScript packages, then Go). Report the pass and
fail count per package. The only accepted failures are the 5 locked tests that
assert old wrong answers (4 CSV amounts, the 245 bps display). Any other failure
means the change is wrong: never edit a locked test to make it pass.
