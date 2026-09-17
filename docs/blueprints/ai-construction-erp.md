# Blueprint ERP Konstruksi Berbasis AI

Status: arah arsitektur dan roadmap produk  
Produk: Konstruksi Finance ERP  
Konteks: Indonesia  
Tanggal: 18 September 2026

## 1. Ringkasan eksekutif

Produk ditujukan menjadi **Construction Intelligence ERP**: sistem transaksi, pengendalian proyek, dan pengetahuan konstruksi yang dilengkapi AI copilot serta agent spesialis.

Prinsip utamanya:

> ERP adalah sumber kebenaran. AI membaca, menganalisis, menjelaskan, dan menyusun draft; backend deterministik memvalidasi dan mencatat transaksi.

AI tidak menjadi sumber harga, regulasi, progres resmi, nilai kontrak, saldo, role, atau approval. Setiap perubahan material tetap melewati permission, validasi domain, state machine, transaksi database, dan audit.

## 2. Tujuan produk

1. Menyatukan tender, proyek, RAB, kontrak, procurement, inventory, progres, biaya, invoice, pajak, kas, dan audit.
2. Menjaga keterlacakan dari dokumen sumber hingga transaksi dan laporan.
3. Memberikan informasi proyek yang tepat waktu kepada setiap peran.
4. Menggunakan AI untuk mempercepat pekerjaan berulang tanpa menurunkan kontrol.
5. Menjadikan pengetahuan proyek dan organisasi dapat dicari serta digunakan kembali.
6. Mendukung operasi multi-proyek dengan kontrol akses dan konfigurasi effective-dated.

## 3. Batas sistem

### ERP bertanggung jawab atas

- identitas, role, dan penugasan proyek;
- master data dan konfigurasi effective-dated;
- state machine dan approval;
- perhitungan finansial final;
- versioning dan snapshot;
- nomor dokumen;
- transaksi, locking, dan rollback;
- audit dan rekonsiliasi;
- laporan resmi.

### AI bertanggung jawab atas

- pencarian dan rangkuman;
- klasifikasi serta ekstraksi dokumen;
- analisis variance dan risiko;
- penjelasan hasil kalkulasi;
- rekomendasi;
- penyusunan draft;
- orkestrasi pekerjaan lintas domain;
- permintaan data yang kurang.

### AI dilarang

- mengarang harga, koefisien, volume, atau regulasi;
- menjalankan SQL produksi bebas;
- membaca secret;
- mengubah role atau permission sendiri;
- menghapus audit;
- mengubah transaksi posted;
- menyetujui draft buatannya sendiri;
- mengakses proyek di luar scope pengguna;
- menjadikan memory percakapan sebagai sumber fakta finansial.

## 4. Kapabilitas yang sudah menjadi fondasi

Fondasi aplikasi saat ini mencakup:

- autentikasi Clerk dan undangan pengguna;
- role-based access control;
- proyek dan status tervalidasi;
- RAB hasil impor dengan baseline serta riwayat versi;
- invoice dan nomor unik;
- aturan pajak effective-dated;
- snapshot perhitungan pajak;
- ringkasan pajak bulanan;
- audit trail;
- advisory lock, timeout, rollback, dan pengujian konkurensi;
- rekonsiliasi undangan lintas server.

Fondasi tersebut dipertahankan dan diperluas, bukan diganti oleh framework AI.

## 5. Arsitektur target

```text
┌──────────────────────────────────────────────────────────┐
│ User Experience                                          │
│ Web ERP · Mobile/Field · Copilot · Email · Messaging     │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│ AI Experience Layer                                      │
│ Chat · Briefing · Document Review · Draft Workspace      │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│ AI Control Plane                                         │
│ Identity · Policy · Agent Registry · Routing · Approval  │
│ Memory · Evaluation · Budget · Audit · Kill Switch       │
└───────────────┬────────────────────────┬─────────────────┘
                │                        │
┌───────────────▼────────────┐  ┌────────▼─────────────────┐
│ Agent Runtime Adapters    │  │ Knowledge Plane          │
│ Hermes · OpenClaw · Other │  │ Docs · Search · Graph    │
└───────────────┬────────────┘  └────────┬─────────────────┘
                │                        │
┌───────────────▼────────────────────────▼─────────────────┐
│ Typed ERP Tool Gateway                                   │
│ Schema · Scope · Idempotency · Approval · Rate Limit     │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│ Construction ERP Domain Services                         │
│ Tender · RAB · Contract · Procurement · Inventory        │
│ Progress · Cost · Billing · Tax · Accounting · Audit     │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│ Data and Integration                                     │
│ PostgreSQL · Object Storage · Event Log · External APIs  │
└──────────────────────────────────────────────────────────┘
```

## 6. Modul bisnis target

### 6.1 Preconstruction dan tender

- pipeline peluang;
- profil pemilik pekerjaan;
- persyaratan tender;
- readiness SBU/SKK;
- bid/no-bid review;
- risk register;
- dokumen penawaran;
- konversi tender menang menjadi proyek.

### 6.2 Project setup dan kontrak

- project charter;
- organisasi dan assignment;
- kontrak, addendum, scope, milestone, dan plafon;
- retention, payment terms, serta variation order;
- konfigurasi proyek yang memiliki periode berlaku.

### 6.3 RAB, RAP, BoQ, dan AHSP

- Master Analisa terpisah dari Master Harga;
- effective-dated coefficient dan price book;
- kalkulasi volume parametrik;
- draft, review, approval, dan baseline;
- revisi tanpa menimpa histori;
- comparison dan impact analysis;
- formula lineage hingga komponen sumber daya.

### 6.4 Procurement

- purchase requisition;
- approval berdasarkan nilai;
- RFQ dan perbandingan penawaran;
- vendor evaluation;
- PO/SPK;
- penerimaan;
- three-way matching;
- invoice dan pembayaran vendor.

### 6.5 Inventory

- gudang dan lokasi;
- stock movement;
- material request, issue, return, dan transfer;
- batch/serial bila diperlukan;
- kebutuhan RAB versus pengadaan dan pemakaian;
- exception serta rekonsiliasi.

### 6.6 Progress dan project control

- WBS dan jadwal;
- baseline waktu dan biaya;
- laporan harian;
- bukti foto dan dokumen;
- progres terverifikasi;
- Kurva-S;
- PV, EV, AC, CPI, SPI, EAC, ETC, VAC, dan TCPI;
- forecast dan variance.

### 6.7 Progress billing

- DP, termin, retensi, dan pelunasan;
- berita acara dan progress certificate;
- plafon kontrak dan variation order;
- pajak berdasarkan tanggal serta kriteria;
- invoice PDF, pengiriman, pembayaran, dan aging;
- rekonsiliasi progress-to-billing-to-cash.

### 6.8 Finance, tax, dan accounting

- cash in/out;
- account payable dan receivable;
- chart of accounts;
- journal posting;
- bank reconciliation;
- project P&L;
- cashflow dan forecast;
- tax sub-ledger;
- period close dan carry-forward;
- koreksi posted transaction melalui reversal.

### 6.9 Document control

- kontrak, gambar, SOP, metode kerja, inspeksi, dan pajak;
- metadata, klasifikasi, dan project scope;
- revision dan supersession;
- approval;
- retention policy;
- checksum dan provenance;
- full-text serta semantic search.

### 6.10 Compliance dan audit

- SBU, SKK, sertifikat, dan masa berlaku;
- segregation of duties;
- approval matrix;
- audit per entitas;
- investigasi, filter, export, dan retention;
- anomaly dan policy violation detection.

## 7. Project Brain

Konsep Gustafta “Brain Project” diadopsi sebagai pola vendor-neutral bernama **Project Brain**.

Project Brain menghubungkan:

- regulasi dan kebijakan;
- kontrak serta addendum;
- gambar dan spesifikasi;
- SOP dan metode kerja;
- keputusan proyek;
- asumsi RAB;
- risiko dan mitigasi;
- lessons learned;
- transaksi ERP yang relevan.

Setiap pengetahuan memiliki:

- sumber;
- penerbit;
- proyek dan klasifikasi;
- tanggal berlaku/berakhir;
- versi;
- status verifikasi;
- tingkat kerahasiaan;
- checksum;
- relasi ke dokumen pengganti.

Vector search hanya menemukan kandidat informasi. Keputusan mengenai aturan yang berlaku ditentukan oleh metadata dan validasi deterministik.

## 8. Agent spesialis

### Orchestrator

Memecah permintaan, memilih agent, menggabungkan hasil, dan menerapkan policy. Tidak mempunyai hak mutasi finansial langsung.

### Tender Agent

Mengekstrak persyaratan, memeriksa readiness, menyusun bid/no-bid brief, dan membuat daftar dokumen kurang.

### Contract Agent

Menandai kewajiban, deadline, penalti, retensi, payment terms, scope gap, dan risiko kontrak dengan kutipan sumber.

### RAB Agent

Membuat draft quantity/analisa, memetakan Master Analisa dan Master Harga, membandingkan versi, serta menjelaskan perubahan biaya.

### Procurement Agent

Membuat draft PR/RFQ, menggabungkan kebutuhan, membandingkan vendor, dan menemukan anomali jumlah atau harga.

### Site Progress Agent

Mengubah laporan harian dan bukti menjadi draft progres WBS serta menunjukkan bukti yang belum memadai.

### Project Control Agent

Menghitung melalui tool deterministik, menganalisis EVM, variance, forecast, dan risiko penyelesaian.

### Finance Agent

Menyiapkan draft billing, memeriksa plafon dan dokumen, menganalisis piutang, retensi, serta cashflow.

### Tax Agent

Menjelaskan aturan terpilih, mencari selisih, menyiapkan review, dan tidak menghitung dari memory.

### Audit Agent

Read-only; memeriksa audit, segregation of duties, pola abnormal, dokumen kurang, dan policy violations.

### Executive Agent

Menyusun briefing lintas proyek dari hasil agent spesialis. Tidak memiliki tool mutasi.

## 9. Pola orkestrasi

### Supervisor–specialist

Default untuk analisis lintas domain. Supervisor memilih hanya agent yang diperlukan.

### Planner–executor–reviewer

Dipakai untuk draft RAB, PR, progres, billing, dan laporan. Reviewer harus terpisah dari executor.

### Parallel investigation

Dipakai untuk cost overrun, keterlambatan, audit proyek, dan investigasi cashflow.

### Deterministic workflow

Dipakai untuk approval, posting, numbering, tax calculation, period close, dan state transition. Tidak perlu dipaksakan menjadi percakapan multi-agent.

## 10. Tingkat otorisasi AI

| Tingkat | Jenis | Contoh | Approval |
|---|---|---|---|
| 0 | Read-only | pencarian, penjelasan, ringkasan | Tidak |
| 1 | Draft | draft RAB, PR, progres, invoice | Review |
| 2 | Submit | kirim draft ke approval | Ya |
| 3 | Controlled mutation | terbitkan PO, baseline, invoice | Wajib |
| 4 | Prohibited | hapus audit, ubah posted transaction | Dilarang |

Backend selalu memvalidasi ulang identity, permission, project scope, version, status, dan nilai input setelah approval.

## 11. Typed ERP Tool Gateway

Contoh tools:

- `getPortfolioSummary`
- `getProjectContext`
- `searchProjectDocuments`
- `compareRabVersions`
- `calculateRabDraft`
- `getCostVariance`
- `draftPurchaseRequest`
- `reconcileMaterialUsage`
- `calculateInvoicePreview`
- `draftProgressBilling`
- `getTaxSummary`
- `explainTaxCalculation`
- `searchAuditEvents`
- `submitDraftForApproval`

Setiap tool wajib mendefinisikan:

- JSON input/output schema;
- permission;
- project scope;
- read/write classification;
- idempotency;
- approval requirement;
- timeout dan retry policy;
- rate/cost limit;
- data sensitivity;
- audit event.

## 12. Posisi framework

### Hermes Agent

Cocok untuk copilot, persistent context, reusable skills, document worker, dan messaging. Digunakan pertama kali dalam mode read-only/draft.

### OpenClaw

Cocok sebagai runtime/adapter untuk tools, channel, atau orkestrasi eksternal. Tidak mendapat akses shell, filesystem, secret, atau database produksi ERP.

### MultiClaw

Diambil pola agent registry, visual coordination, dan collaboration-nya. Tidak dijadikan dependency arsitektur karena nama serta implementasinya belum menjadi standar stabil.

### Gustafta

Menjadi referensi domain dan calon knowledge/compliance service. Brain Project, Bedah Dokumen, tender-to-project, SBU/SKK, serta project intelligence diadopsi sebagai konsep vendor-neutral. Integrasi langsung hanya setelah API, keamanan, isolasi tenant, data residency, dan SLA terverifikasi.

Semua framework terhubung melalui adapter agar dapat diganti tanpa mengubah ERP core.

## 13. Memory dan data governance

Empat jenis memory dipisahkan:

1. Session memory: konteks percakapan sementara.
2. User preference: format dan preferensi, bukan fakta transaksi.
3. Project memory: keputusan dan asumsi dengan sumber serta masa berlaku.
4. Regulatory knowledge: dokumen resmi dengan metadata dan status verifikasi.

Larangan:

- secret atau credential tidak disimpan;
- memory tidak menentukan permission;
- angka transaksi selalu dibaca ulang;
- data tenant/proyek tidak bercampur;
- dokumen tidak digunakan untuk training tanpa izin eksplisit.

## 14. AI execution record

Setiap pekerjaan agent menyimpan:

- requester dan identity;
- project scope;
- agent serta versi policy;
- model/provider;
- tools yang dipanggil;
- dokumen sumber;
- ringkasan alasan;
- output terstruktur;
- confidence dan warnings;
- approval;
- mutasi final;
- token, biaya, durasi, dan status.

Chain-of-thought internal tidak disimpan. Yang disimpan adalah sumber, formula, tool results, dan alasan terstruktur yang dapat diaudit.

## 15. Keamanan

- service AI terpisah dari API ERP;
- read-only sebagai default;
- allowlist tools;
- short-lived service identity;
- least privilege dan project scope;
- network egress restriction;
- sandbox untuk dokumen dan kode;
- prompt-injection scanning;
- pemisahan konten sumber dari system instruction;
- idempotency untuk mutation;
- approval dan segregation of duties;
- kill switch per agent dan global;
- plugin/skill supply-chain review;
- encryption in transit/at rest;
- data classification dan retention;
- monitoring, anomaly detection, serta incident history.

## 16. Evaluasi AI

Evaluation set minimum mencakup:

- jawaban sesuai angka ERP;
- citation ke record/dokumen benar;
- penolakan akses proyek lain;
- penolakan instruksi dalam dokumen;
- tidak mengarang harga/regulasi;
- tidak menggunakan aturan kedaluwarsa;
- tidak memakai memory lama untuk angka;
- tool call sesuai permission;
- approval tidak dapat dilewati;
- hasil tetap benar saat model diganti;
- bahasa dan penjelasan dapat dipahami pengguna.

Metrik:

- grounded answer rate;
- citation accuracy;
- unauthorized action rate;
- draft acceptance/revision rate;
- false-positive anomaly rate;
- task completion rate;
- latency dan biaya;
- human time saved;
- incident count.

## 17. Roadmap implementasi

### Fase 0 — Production foundation

- hilangkan rate/periode hard-coded;
- tutup gap RBAC dan segregation of duties;
- lengkapi error handling;
- audit pagination dan drill-down;
- monitoring dan notifikasi operasional;
- procurement/actual-cost minimum viable flow.

Gate: kontrak API stabil, semua mutation memiliki policy dan audit, serta laporan tidak bergantung pada data contoh.

### Fase 1 — Read-only AI copilot

- portfolio/project Q&A;
- RAB version explanation;
- invoice/tax explanation;
- audit search;
- project risk briefing;
- source citation.

Gate: tidak ada kebocoran lintas proyek dan grounded-answer evaluation mencapai target.

### Fase 2 — Document intelligence dan Project Brain

- upload dan classification;
- extraction dengan referensi halaman;
- revision/supersession;
- contract obligation register;
- SOP/method search;
- tender readiness.

Gate: hasil AI selalu dapat diverifikasi ke sumber dan dokumen lama tidak dipakai sebagai aturan aktif.

### Fase 3 — Draft agents

- draft RAB;
- draft PR/RFQ;
- draft laporan harian dan progres;
- draft progress billing;
- draft tax review.

Gate: semua draft berstatus jelas, tidak mengubah ledger, dan memiliki reviewer.

### Fase 4 — Multi-agent project intelligence

- cost-overrun investigation;
- EVM dan forecast;
- material reconciliation;
- progress-to-billing;
- cashflow risk;
- executive briefing.

Gate: orchestrator dapat dibatasi biaya, waktu, tools, dan scope.

### Fase 5 — Controlled execution

- submit untuk approval;
- mutation risiko rendah setelah approval;
- durable workflow dan retry;
- incident management;
- model routing dan optimization.

Gate: tidak ada agent yang dapat membuat sekaligus menyetujui transaksi material.

## 18. Urutan prioritas produk

1. Keamanan dan konsistensi ERP core.
2. Procurement, inventory, actual cost, dan progress data.
3. Document control dan Project Brain.
4. AI copilot read-only.
5. Draft agents.
6. Multi-agent analytics.
7. Controlled execution.
8. AI parametrik/vision untuk gambar setelah dataset dan review workflow matang.

## 19. Keputusan arsitektur

1. ERP core tidak bergantung pada satu model atau framework agent.
2. Hermes/OpenClaw/MultiClaw dipasang melalui adapter.
3. Gustafta diperlakukan sebagai referensi/calon service, bukan otoritas.
4. AI tidak mengakses database produksi secara langsung.
5. Semua financial logic tetap deterministik.
6. Semua nilai yang berubah memiliki effective date dan snapshot.
7. Approved baseline dan posted transaction tidak ditimpa.
8. Human approval meningkat sesuai tingkat risiko.
9. Multi-agent hanya digunakan jika tugas benar-benar lintas domain.
10. Setiap hasil AI harus grounded, scoped, dan auditable.

## 20. Definisi keberhasilan

Blueprint berhasil ketika:

- pengguna dapat menelusuri setiap angka ke transaksi dan dokumen sumber;
- agent mempercepat analisis tanpa memperluas permission pengguna;
- draft AI tidak pernah dianggap final tanpa workflow;
- pergantian model/runtime tidak mengubah kontrak bisnis;
- sistem tetap berfungsi jika seluruh fitur AI dimatikan;
- tidak ada transaksi finansial yang bergantung hanya pada jawaban model;
- pengetahuan proyek dapat digunakan ulang dengan versi dan provenance;
- keputusan manusia, policy, dan audit tetap menjadi kendali utama.

## 21. Referensi dan batas penggunaannya

- `docs/references/odoo-construction-erp.md`: referensi proses ERP konstruksi.
- `docs/references/erabe-rab-project-workflow.md`: referensi alur RAB, progres, billing, dan field access.
- `https://gustafta.my.id`: referensi domain untuk knowledge, dokumen, tender, compliance, dan project intelligence.
- Hermes Agent, OpenClaw, serta proyek MultiClaw: referensi runtime dan pola orkestrasi agent.

Seluruh sumber eksternal digunakan untuk pola dan terminologi. Klaim vendor, tarif, regulasi, harga, integrasi, serta kemampuan teknis wajib diverifikasi sebelum menjadi requirement atau konfigurasi produksi.