# Referensi SOP Keuangan dan Administrasi Konstruksi

Ditinjau dari delapan SOP serta enam contoh dokumen ketenagakerjaan yang diunggah pada 20 September 2026, dan sintesis Qwen yang menyertainya. Dokumen ini menerjemahkan sumber tersebut menjadi kebutuhan produk, kontrol internal, dan workflow. Seluruh sumber merupakan contoh kebijakan atau administrasi organisasi, bukan sumber hukum, tarif, klausul kontrak, atau konfigurasi produksi.

## Sumber

- `8._SOP_Penyusunan_Laporan_Keuangan_Konstruksi_1789853397265.pdf`
- `9._SOP_Petty_Cash_Proyek_(Kas_Kecil)_Perusahaan_Kontraktor_1789853397266.pdf`
- `10._SOP_Pembayaran_Upah_Tenaga_Kerja_Proyek_Perusahaan_Kontrak_1789853397266.pdf`
- `11._SOP_Penagihan_Pembayaran_Proyek_1789853397267.pdf`
- `14._SOP_Laporan_Pajak_Jasa_Konstruksi_1789853424277.pdf`
- `17._SOP_Lembur_Karyawan_1789853435705.pdf`
- `37._Staff_Admin_1789853451083.pdf`
- `38._Staff_Keuangan_1789853451084.pdf`
- `1._Contoh_PKWT_(Perjanjian_Kerja_Waktu_Tertentu)_1789855612845.pdf`
- `2._Contoh_PKWTT-Operator_1789855612846.pdf`
- `3._Contoh_PKWTT-Staff_1789855612847.pdf`
- `4._Perjanjian_Kerja_Masa_Percobaan_1789855612847.doc`
- `5._Contoh_PKWT_(versi_2)_1789855612848.doc`
- `6._SURAT_PENGANGKATAN_KARYAWAN_TETAP_1789855612849.doc`
- `Pasted--Prompt-Replit-untuk-Aplikasi-ERP-Keuangan-Konstruksi-B_1789853237722.txt`

## Prinsip penerjemahan SOP

SOP tidak ditanam sebagai rangkaian kondisi permanen di kode. Sistem perlu memisahkan:

- definisi workflow;
- role dan segregation of duties;
- approval matrix;
- required evidence;
- threshold;
- kalender dan deadline;
- formula dan tarif;
- versi SOP serta periode berlaku.

Setiap instance workflow menyimpan versi kebijakan yang digunakan. Perubahan SOP tidak boleh mengubah transaksi atau approval historis.

## 1. Pelaporan keuangan konstruksi

### Pola yang relevan

- pencatatan berbasis akrual;
- chart of accounts dengan kode unik;
- jurnal umum dan buku besar;
- bukti transaksi wajib;
- klasifikasi pendapatan, biaya langsung, biaya tidak langsung, dan biaya umum;
- rekonsiliasi saldo;
- neraca, laba rugi, arus kas, serta catatan atas laporan keuangan;
- verifikasi manajemen dan dukungan audit.

### Implikasi produk

- ledger menggunakan balanced journal entry;
- posting terpisah dari dokumen sumber;
- period close mengunci backdating;
- koreksi dilakukan melalui reversal;
- laporan perusahaan dan proyek menggunakan dimensi proyek/WBS/cost code;
- setiap angka dapat ditelusuri ke jurnal dan dokumen sumber;
- laporan memiliki status draft, reviewed, approved, issued, dan superseded.

### Perlu verifikasi

Kebijakan audit tahunan, standar akuntansi, format laporan, periode penutupan, serta masa simpan harus dikonfirmasi dengan penasihat akuntansi dan regulasi yang berlaku.

## 2. Petty cash proyek

### Workflow yang relevan

```text
Request
→ Review kelengkapan dan budget
→ Approval
→ Disbursement
→ Usage dan evidence
→ Settlement/return
→ Reconciliation
→ Verification
→ Monthly evaluation
```

### Data minimum

- proyek dan lokasi kas;
- requester, custodian/kasir, approver;
- tujuan, nilai, tanggal kebutuhan;
- budget/cost code;
- nilai disetujui dan dicairkan;
- detail penggunaan;
- receipt/evidence;
- sisa dikembalikan;
- saldo pembukaan dan penutupan;
- status rekonsiliasi.

### Kontrol

- requester tidak dapat menyetujui atau merekonsiliasi permintaan sendiri;
- pencairan tidak boleh terjadi sebelum approval;
- settlement mengikat setiap pengeluaran ke bukti;
- replenishment tidak dihitung sebagai expense baru;
- saldo buku harus direkonsiliasi dengan kas fisik;
- missing evidence menjadi exception dengan owner dan due date.

GPS, batas hari, dan threshold tidak di-hardcode; penerapannya merupakan kebijakan perusahaan/proyek yang berversi.

## 3. Pembayaran upah tenaga kerja

### Workflow yang relevan

```text
Attendance/verified work
→ Payroll input
→ Validation
→ Calculation
→ Review dan dual approval
→ Disbursement
→ Payslip
→ Accounting posting
→ Archive
```

### Data minimum

- worker identity dan engagement type;
- proyek/WBS/cost code;
- payroll period;
- attendance, regular hours, dan overtime;
- rate version;
- allowance, deduction, tax, dan net pay;
- approval;
- payment proof;
- journal reference.

### Kontrol

- attendance tidak langsung menjadi pembayaran tanpa cut-off dan review;
- rate memiliki periode berlaku;
- perubahan data setelah cut-off membuat adjustment pada periode berikut atau reversal;
- maker, reviewer, approver, dan payer dipisahkan sesuai policy;
- payroll detail dibatasi karena mengandung data personal.

UMR, PPh 21, allowance, deduction, dan formula lembur wajib berasal dari konfigurasi/regulasi terverifikasi, bukan teks SOP atau prompt.

## 4. Lembur

### Workflow yang relevan

```text
Overtime request/order
→ Supervisor approval
→ Scheduled overtime
→ Actual time capture
→ Supervisor verification
→ Payroll calculation
→ Compensation/payment
```

Sistem harus membedakan planned, approved, dan actual overtime. Permintaan terlambat atau darurat membutuhkan alasan dan jalur exception, bukan overwrite.

Syarat masa kerja, pemberitahuan satu hari, bentuk kompensasi, batas jam, dan tarif merupakan policy effective-dated yang perlu verifikasi legal/HR.

## 5. Penagihan pembayaran proyek

### Workflow yang relevan

```text
Verified progress/milestone
→ Billing package
→ Internal review
→ Client submission
→ Receipt acknowledgement
→ Monitoring
→ Payment/partial payment
→ Allocation dan reconciliation
→ Collection/escalation
```

### Billing package

- kontrak dan addendum yang berlaku;
- progres/milestone terverifikasi;
- berita acara atau certificate;
- invoice;
- perhitungan pajak;
- retention;
- dokumen pendukung;
- delivery/receipt evidence.

### Kontrol

- invoice tidak boleh hanya mengandalkan persentase bebas;
- nilai kumulatif menjaga plafon kontrak dan approved variation;
- submission, rejection, resubmission, dispute, dan collection dicatat;
- pembayaran parsial dialokasikan secara eksplisit;
- overdue dan retention claimable menggunakan kalender/terms kontrak.

## 6. Laporan pajak jasa konstruksi

### Workflow yang relevan

```text
Document collection
→ Completeness check
→ Deterministic tax calculation
→ Review/reconciliation
→ Approval
→ Filing/submission
→ Payment evidence
→ Archive
→ Correction/evaluation
```

### Kontrol

- tax rule dipilih berdasarkan tanggal, kriteria, yurisdiksi, dan versi;
- invoice menyimpan immutable calculation snapshot;
- checklist dokumen dan exception tercatat;
- filing period dibedakan dari transaction period;
- koreksi tidak menimpa laporan yang telah diajukan;
- bukti pengajuan dan pembayaran ditautkan ke periode.

Tarif PPN/PPh, tanggal jatuh tempo, format e-Faktur/SPT, dan masa simpan dokumen pada prompt Qwen tidak dianggap authoritative.

## 7. Staff Admin dan document control

### Pola yang relevan

- document receipt dan acknowledgement;
- completeness check;
- register dokumen masuk/keluar;
- klasifikasi proyek/departemen;
- invoice vendor intake;
- payment request preparation;
- stock administration;
- delivery dan receipt administration;
- reporting.

### Pemisahan tanggung jawab

Staff Admin dapat menerima, mengklasifikasi, dan menyiapkan permintaan pembayaran, tetapi tidak otomatis berhak menyetujui atau mengeksekusi pembayaran. SOP sumber mencampur preparation dan payment processing; ERP harus memisahkannya.

Dokumen membutuhkan nomor, jenis, proyek, pihak, tanggal, revisi, status, confidentiality, checksum, approval, dan supersession.

## 8. Staff Keuangan dan treasury

### Pola yang relevan

- verifikasi dokumen pengajuan dana;
- budget check;
- payment preparation;
- project cash monitoring;
- bank reconciliation;
- cash plan dan forecast;
- periodic reporting;
- internal audit support.

### Kontrol

- payment request, approval, release, dan reconciliation dipisahkan;
- beneficiary dan rekening bank memiliki verification workflow;
- pembayaran terkait invoice/receipt/contract yang valid;
- bank statement diimpor sebagai immutable source;
- auto-match menghasilkan candidate match yang dapat direview;
- cash forecast menyimpan asumsi dan versi.

## 9. Kontrak kerja dan pengangkatan karyawan

### Lifecycle yang relevan

```text
Candidate/worker identity
→ Employment offer or agreement draft
→ HR/legal review
→ Employee acknowledgement and signatures
→ Active employment
→ Probation evaluation, bila sah dan berlaku
→ Appointment, extension, change, or separation
→ Payroll/benefit activation or adjustment
→ Archive and retention
```

Sistem harus membedakan setidaknya PKWT, PKWTT, masa percobaan, dan surat keputusan pengangkatan. Dokumen baru tidak boleh menimpa perjanjian sebelumnya; perubahan jabatan, grade, penempatan, upah, fasilitas, masa kerja, atau status hubungan kerja dibuat sebagai versi atau keputusan baru dengan periode berlaku.

### Data minimum

- identitas pekerja dan perusahaan, dengan akses sangat terbatas;
- jenis hubungan kerja dan dasar dokumen;
- nomor, versi, status, tanggal dibuat, tanggal ditandatangani, serta periode berlaku;
- posisi, grade, departemen/section, atasan, proyek/lokasi, dan titik rekrutmen;
- tanggal mulai kerja, akhir kontrak, dan tanggal efektif pengangkatan;
- komponen upah, tunjangan, fasilitas, pajak, jaminan sosial, serta policy version;
- pola hari/jam kerja dan referensi aturan lembur;
- masa evaluasi, evaluator, kriteria, hasil, dan keputusan;
- pihak penandatangan, kapasitas kewenangan, acknowledgement, dan bukti tanda tangan;
- referensi peraturan perusahaan/PKB serta dokumen yang menggantikan atau memperpanjang;
- alasan perubahan/pengakhiran dan bukti proses yang diwajibkan.

### Kontrol

- kontrak menggunakan template berversi dan field terstruktur, bukan salin-tempel dokumen lama;
- HR menyiapkan, pejabat berwenang menyetujui, pekerja mengakui, dan perubahan status diaudit;
- tanggal mulai, akhir, durasi, dan tanggal efektif harus konsisten secara otomatis;
- aktivasi payroll dan benefit mengikuti tanggal efektif serta keputusan yang telah disetujui;
- pengingat kedaluwarsa tidak otomatis memperpanjang atau mengakhiri hubungan kerja;
- hasil evaluasi tidak otomatis menjadi pengangkatan atau PHK tanpa keputusan dan dokumen sah;
- data upah, alamat, identitas, evaluasi, dan dokumen kontrak diperlakukan sebagai data personal rahasia;
- akses dokumen mengikuti purpose, role, legal hold, retention policy, dan audit download;
- tanda tangan, meterai, rangkap dokumen, dan penyelesaian perselisihan harus mengikuti aturan yang telah diverifikasi.

### Perlu verifikasi

Contoh sumber berasal terutama dari 2005–2010 dan tidak boleh dipakai sebagai template legal tanpa review. Istilah Jamsostek, masa percobaan, kompensasi, pemutusan hubungan kerja, perpanjangan PKWT, pajak, jam kerja, lembur, penempatan, kerahasiaan, serta klausul pelanggaran harus diverifikasi terhadap regulasi, PKB/peraturan perusahaan, dan praktik organisasi yang berlaku.

Salah satu contoh PKWT menyatakan masa dua tahun tetapi rentang tanggalnya melampaui dua tahun. Sistem perlu menolak ketidakkonsistenan semacam ini. Nama, perusahaan, alamat, nomor identitas, nominal, serta klausul pada contoh hanya data ilustratif dan tidak boleh dijadikan master data atau default produksi.

## 10. Integrasi aplikasi lapangan

Pola dua aplikasi—ERP finansial dan aplikasi site—relevan, tetapi kontrak integrasi harus netral terhadap produk.

Event awal:

- attendance recorded/approved;
- overtime approved/verified;
- material received/inspected;
- material issued/returned;
- progress measured/approved;
- equipment usage verified;
- petty-cash request/settlement submitted.

Setiap event integrasi membutuhkan:

- source system dan tenant;
- unique event ID;
- idempotency;
- occurred-at dan received-at;
- project/WBS scope;
- schema version;
- actor/device;
- evidence references;
- signature verification;
- processing status serta dead-letter/retry.

API key + HMAC pada prompt hanyalah salah satu opsi. Desain akhir perlu rotasi credential, replay protection, timestamp/nonce, rate limit, dan audit.

## 11. Peran AI

AI dapat:

- mengklasifikasi dokumen;
- mengekstrak field dan mendeteksi kekurangan;
- membandingkan draft kontrak dengan template yang disetujui dan menandai deviasi;
- mendeteksi konflik tanggal, field kosong, dan referensi kebijakan yang kedaluwarsa;
- menyarankan cost code;
- mencocokkan kandidat PO/receipt/invoice;
- menjelaskan variance;
- menyusun draft laporan dan collection notice;
- merangkum exception.

AI tidak boleh:

- menentukan jenis hubungan kerja atau keabsahan klausul;
- menyetujui kontrak, pengangkatan, perpanjangan, atau pemutusan kerja;
- menetapkan upah, benefit, masa percobaan, atau kompensasi;
- menyetujui pembayaran;
- menetapkan tarif/regulasi;
- membuat journal posted;
- menganggap foto sebagai bukti final tanpa verifikasi;
- menandai rekonsiliasi selesai sendiri;
- mengubah period close;
- memperluas permission.

## 12. Urutan implementasi yang direkomendasikan

1. WBS/cost code dan four-way cost model.
2. Committed cost melalui PO/SPK/kontrak subkon.
3. Document/evidence registry.
4. AP minimum flow dan three-way matching.
5. Petty cash dan project cash.
6. Bank reconciliation dan treasury forecast.
7. Progress billing dan AR collection.
8. Worker master, kontrak kerja berversi, dan payroll/overtime.
9. General ledger, period close, dan laporan akrual.
10. Tax filing workspace.
11. Site integration events.
12. AI document/exception assistant.

## 13. Bagian yang tidak diadopsi langsung

- Pergantian stack aplikasi ke Next.js, Prisma, atau NextAuth.
- Tarif pajak, UMR, retensi, threshold budget, approval, OTP, dan batas hari sebagai konstanta.
- Nama, alamat, nomor identitas, nominal upah, dan identitas perusahaan dari contoh kontrak.
- Klausul ketenagakerjaan lama, termasuk istilah jaminan sosial, masa percobaan, kompensasi, dan PHK, tanpa review HR/legal.
- Aktivasi, perpanjangan, pengangkatan, atau pengakhiran hubungan kerja hanya berdasarkan kalender atau keputusan AI.
- Klaim masa simpan sepuluh tahun tanpa verifikasi resmi.
- GPS wajib untuk seluruh bukti petty cash.
- Anggapan bahwa satu persentase opname otomatis cukup untuk invoice.
- Auto-posting dari event site tanpa validation, review, dan idempotency.
- Skema database berupa satu tabel transaksi generik atau field JSON untuk item material.
- Klaim aplikasi “100% dapat dipercaya” hanya karena memakai database guardrail.

## Aturan penggunaan

- Perlakukan SOP sebagai input desain workflow, bukan sumber regulasi.
- Perlakukan contoh kontrak sebagai referensi struktur dokumen, bukan template legal siap pakai.
- Verifikasi kebijakan perusahaan dan aturan pemerintah sebelum implementasi.
- Gunakan konfigurasi effective-dated untuk seluruh nilai yang berubah.
- Simpan versi workflow/policy pada setiap transaksi.
- Prioritaskan segregation of duties, evidence, idempotency, dan auditability.
- Pertahankan stack serta arsitektur aplikasi yang sudah ada.