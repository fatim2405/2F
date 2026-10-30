package scheduler

import (
	"testing"
	"time"
)

// The daily close for a Bahrain business day must become due runDelay
// minutes after Bahrain midnight (21:00 UTC the previous UTC day), not
// after UTC midnight.
func TestDueBusinessDate_ClosesAfterBahrainMidnightNotUTC(t *testing.T) {
	const delay = 15
	cases := []struct {
		name     string
		now      time.Time
		wantDue  bool
		wantDate string
	}{
		// 00:10 Bahrain on 10 Sep: inside the grace period.
		{"before grace", time.Date(2026, 9, 9, 21, 10, 0, 0, time.UTC), false, ""},
		// 00:20 Bahrain on 10 Sep: 9 Sep is complete and due. The old
		// code read the UTC date (9 Sep) and closed 8 Sep instead.
		{"just after grace", time.Date(2026, 9, 9, 21, 20, 0, 0, time.UTC), true, "2026-09-09"},
		// 02:59 Bahrain on 10 Sep: still 9 Sep.
		{"before UTC midnight", time.Date(2026, 9, 9, 23, 59, 0, 0, time.UTC), true, "2026-09-09"},
		// 12:00 Bahrain on 10 Sep: unchanged from old behaviour.
		{"midday", time.Date(2026, 9, 10, 9, 0, 0, 0, time.UTC), true, "2026-09-09"},
		// Year boundary: 00:20 Bahrain on 1 Jan 2027.
		{"year end", time.Date(2026, 12, 31, 21, 20, 0, 0, time.UTC), true, "2026-12-31"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			date, due := dueBusinessDate(c.now, delay)
			if due != c.wantDue {
				t.Fatalf("due = %v, want %v", due, c.wantDue)
			}
			if due && date.Format("2006-01-02") != c.wantDate {
				t.Fatalf("business date = %s, want %s", date.Format("2006-01-02"), c.wantDate)
			}
		})
	}
}
