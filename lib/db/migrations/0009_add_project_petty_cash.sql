CREATE TABLE IF NOT EXISTS "petty_cash_policy_versions" (
  "id" text PRIMARY KEY,
  "version" text NOT NULL UNIQUE,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "source_note" text NOT NULL,
  "evidence_due_days" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "petty_cash_policy_valid_period"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "petty_cash_policy_evidence_due_days_positive"
    CHECK ("evidence_due_days" > 0)
);

INSERT INTO "petty_cash_policy_versions" (
  "id", "version", "effective_from", "source_note", "evidence_due_days"
) VALUES (
  'petty-cash-policy-initial',
  'SOP-KAS-KECIL-INITIAL',
  DATE '2000-01-01',
  'Konfigurasi awal dari SOP kas kecil; nilai wajib ditinjau perusahaan sebelum produksi',
  3
) ON CONFLICT ("version") DO NOTHING;

CREATE TABLE IF NOT EXISTS "petty_cash_requests" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE RESTRICT,
  "project_code" text NOT NULL,
  "project_name" text NOT NULL,
  "requester_user_id" text NOT NULL,
  "requester_name" text NOT NULL,
  "purpose" text NOT NULL,
  "cost_code" text NOT NULL,
  "requested_amount" bigint NOT NULL,
  "approved_amount" bigint,
  "disbursed_amount" bigint,
  "spent_amount" bigint,
  "returned_amount" bigint,
  "physical_cash_amount" bigint,
  "status" text NOT NULL DEFAULT 'DIAJUKAN',
  "requested_at" date NOT NULL,
  "evidence_due_at" date NOT NULL,
  "policy_version_id" text NOT NULL REFERENCES "petty_cash_policy_versions"("id") ON DELETE RESTRICT,
  "policy_version" text NOT NULL,
  "approver_user_id" text,
  "approver_name" text,
  "approval_note" text,
  "approved_at" timestamptz,
  "disburser_user_id" text,
  "disburser_name" text,
  "disbursement_reference" text,
  "disbursed_at" timestamptz,
  "settled_at" timestamptz,
  "reconciler_user_id" text,
  "reconciler_name" text,
  "reconciliation_note" text,
  "reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "petty_cash_requests_amount_positive" CHECK ("requested_amount" > 0),
  CONSTRAINT "petty_cash_requests_status_supported"
    CHECK ("status" IN ('DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DICAIRKAN', 'DIPERTANGGUNGJAWABKAN', 'DIREKONSILIASI'))
);

CREATE INDEX IF NOT EXISTS "petty_cash_requests_project_created_idx"
  ON "petty_cash_requests" ("project_id", "created_at");

CREATE TABLE IF NOT EXISTS "petty_cash_expenses" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL REFERENCES "petty_cash_requests"("id") ON DELETE CASCADE,
  "expense_date" date NOT NULL,
  "description" text NOT NULL,
  "amount" bigint NOT NULL,
  "receipt_reference" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "petty_cash_expenses_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX IF NOT EXISTS "petty_cash_expenses_request_idx"
  ON "petty_cash_expenses" ("request_id");