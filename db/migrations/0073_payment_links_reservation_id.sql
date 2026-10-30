-- Which pay attempt holds a 'reserved' payment link. A reservation older than
-- the timeout can be re-claimed by another buyer; the original attempt must
-- be able to tell it no longer holds the link before it captures (incident
-- 2026-05-14: a slow payment let a second buyer use the same link and both
-- were charged).
ALTER TABLE payment_links ADD COLUMN reservation_id UUID;
