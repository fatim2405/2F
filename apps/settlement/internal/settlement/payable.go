package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// Exact integer subtraction. This used to go through float32 BD
// ((gross/1000 - fee/1000) * 1000), which has ~7 significant digits: on a
// 123,456.789 BD batch with a 3,086.420 BD fee it paid out 2 fils too few.
// This value is the actual payout, not a display figure.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
