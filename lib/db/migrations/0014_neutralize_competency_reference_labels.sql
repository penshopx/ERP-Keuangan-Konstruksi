ALTER TABLE competency_catalog
  ADD COLUMN IF NOT EXISTS source_note text NOT NULL DEFAULT 'Referensi pengguna; validitas hukum harus diverifikasi terhadap Kemnaker.';

UPDATE competency_catalog
SET
  title = occupation || ' Level ' || level,
  source_note = 'Referensi katalog dari pengguna; bukan penetapan legal. Verifikasi status dan validitas terhadap Kemnaker sebelum digunakan.',
  validity_status = 'REFERENCE_ONLY';