-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils,
-- ~2.147M BD) and settlement added to it in int32, which wraps negative
-- without an error. The volume tier starts at 2,000,000 BD, so ~147K BD
-- later the counter would go negative and silently turn the tier off for
-- every merchant. (apps/api's comment already assumed BIGINT.)
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;
