-- migrate:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS audit_logs_pending_resend_compensation_idx;
-- migrate:next-statement
CREATE INDEX CONCURRENTLY audit_logs_pending_resend_compensation_idx
ON audit_logs ("timestamp")
WHERE action = 'KEGAGALAN PARSIAL KOMPENSASI KIRIM ULANG UNDANGAN'
  AND metadata->>'reconciliationRequired' = 'true';