# Referensi Alur RAB dan Proyek dari ERAbe

Ditinjau dari halaman publik `https://erabe.id/prelaunch` dan ringkasan terlampir pada 17 September 2026. Referensi ini dipakai untuk memahami pola produk dan alur kerja, bukan sebagai spesifikasi, sumber regulasi, atau dasar harga.

## Pola yang relevan

### 1. Perhitungan kuantitas parametrik

Input dimensi dari gambar kerja dapat menghasilkan kuantitas pekerjaan seperti volume beton, berat pembesian, dan luas bekisting. Hasilnya sebaiknya masuk sebagai draft item RAB dengan:

- rumus dan input yang dapat ditinjau;
- satuan, pembulatan, dan sumber kuantitas yang jelas;
- tautan ke gambar atau revisi dokumen sumber;
- status review sebelum menjadi baseline.

Perubahan input di hulu tidak boleh diam-diam mengubah baseline yang telah disetujui. Sistem harus membuat revisi atau versi baru dan menunjukkan dampak perubahannya.

### 2. Pemisahan Master Analisa dan Master Harga

Koefisien sumber daya dalam analisa pekerjaan perlu dipisahkan dari harga material, tenaga, dan alat. Dengan begitu:

- analisa dapat diberi versi dan periode efektif;
- harga dapat berbeda menurut wilayah, pemasok, proyek, dan tanggal;
- overhead, profit, pajak, dan contingency tidak tercampur dengan biaya dasar;
- setiap total dapat ditelusuri kembali ke komponen pembentuknya.

### 3. Rantai kalkulasi yang dapat diaudit

Alur RAP/modal → markup atau margin → pajak → nilai kontrak berguna sebagai model presentasi, tetapi formula harus dapat dikonfigurasi. Setiap hasil perlu menyimpan:

- versi RAB dan aturan yang digunakan;
- nilai input dan hasil setiap tahap;
- alasan override;
- aktor serta waktu persetujuan.

### 4. Invoice termin dengan kontrol plafon

Skema DP, termin, retensi, dan pelunasan relevan untuk aplikasi. Kontrol penting:

- total tagihan tidak boleh melewati nilai kontrak dan variation order yang disetujui;
- nilai termin harus ditautkan ke progres atau dokumen pendukung;
- retensi dan pelepasannya memiliki jadwal serta status tersendiri;
- nomor invoice unik dan dialokasikan secara aman dalam transaksi;
- koreksi dokumen final dilakukan melalui pembatalan atau reversal, bukan overwrite.

### 5. Progres berbobot dan Kurva-S

Progres fisik per item WBS/RAB dapat dibobot berdasarkan nilai atau metode lain yang disetujui. Sistem perlu memisahkan:

- rencana versus aktual;
- progres fisik versus realisasi biaya;
- tanggal pelaporan dan periode cut-off;
- sumber bukti serta pihak yang memverifikasi.

Kurva-S dan deviasi harus dapat ditelusuri ke item pembentuknya, bukan hanya angka agregat dashboard.

### 6. Rekonsiliasi kebutuhan dan realisasi

Kebutuhan material dan tenaga dari analisa dapat dibandingkan dengan:

- permintaan dan pengeluaran gudang;
- purchase order dan penerimaan;
- timesheet atau catatan tenaga kerja;
- kas keluar dan invoice vendor;
- biaya aktual per proyek dan WBS.

Perbedaan merupakan exception yang perlu ditinjau, bukan otomatis dianggap kesalahan atau langsung mengubah baseline.

### 7. Akses terbatas untuk tim lapangan

Pola anggota lapangan memperbarui progres tanpa melihat data harga relevan untuk RBAC. Hak akses harus ditentukan oleh peran, proyek yang ditugaskan, jenis data, dan aksi. Pengguna tanpa penugasan harus tetap fail-closed.

### 8. AI sebagai pembuat draft

AI dapat membantu membaca dokumen atau menyusun draft RAB, tetapi hasilnya tidak boleh langsung menjadi transaksi atau baseline. Setiap keluaran harus:

- ditandai sebagai hasil AI;
- menyertakan input dan asumsi;
- divalidasi terhadap analisa dan master harga yang disetujui;
- melewati review manusia;
- gagal secara eksplisit jika sumber atau tingkat keyakinan tidak memadai.

AI tidak boleh mengarang harga, regulasi, koefisien, atau volume yang tidak dapat dilacak.

## Bagian yang tidak diadopsi

- Harga, paket lisensi, promosi, checkout, dan klaim komersial ERAbe.
- Angka pada proyek contoh, termasuk tarif pajak, retensi, margin, progres, dan nilai kontrak.
- Klaim bahwa suatu AHSP “resmi” atau selalu diperbarui tanpa pemeriksaan dokumen pemerintah.
- Jumlah kalkulator atau batas termin sebagai batas produk ini.
- Mekanisme perubahan hulu yang otomatis menimpa seluruh hasil hilir tanpa versioning dan approval.
- Klaim manfaat, akurasi, atau kepatuhan yang tidak disertai bukti independen.

## Implikasi untuk roadmap

Referensi ini memperkuat prioritas yang sudah ada:

1. Siklus RAB/RAP/baseline/revisi dengan perbandingan versi.
2. Procurement, inventory, dan actual cost per WBS.
3. Progres lapangan, bukti, approval, dan Kurva-S.
4. Termin, retensi, pelunasan, dan rekonsiliasi pembayaran.
5. Formula lineage dan audit trail untuk setiap perhitungan.
6. RBAC khusus proyek untuk pengguna kantor dan lapangan.
7. AI terbatas pada draft yang wajib diverifikasi.

Semua nilai regulasi dan domain tetap mengikuti standar konfigurasi versioned/effective-dated proyek.