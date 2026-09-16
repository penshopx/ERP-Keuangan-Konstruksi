# Referensi Odoo untuk Konstruksi Finance ERP

Dokumen ini merangkum bagian yang relevan dari materi Odoo yang diunggah pada 16 September 2026. Materi sumber dipakai sebagai referensi proses dan terminologi, bukan sebagai spesifikasi produk, sumber hukum, atau bukti klaim manfaat.

## Sumber

- `attached_assets/ODOO-ERP_1789551279796.docx`
- `attached_assets/02-Odoo-Project-Kontruksi-ALL-2_(1)_1789551279798.pdf`
- `attached_assets/01-ERP_Odoo-webinar-Konstruksi_ERP_Odoo-19_Nov_2025-rev_2_(2)_1789551279799.pdf`

## Prinsip yang relevan

### 1. Satu sumber data lintas proses

Data proyek, RAB, pengadaan, persediaan, biaya aktual, invoice, pembayaran, pajak, dan audit sebaiknya menggunakan identitas proyek dan master data yang konsisten. Transaksi operasional harus mengalir ke cost control dan pembukuan tanpa input ulang.

### 2. Alur procure-to-pay

Referensi menunjukkan kebutuhan alur:

1. Permintaan pembelian dari proyek.
2. Persetujuan sesuai batas kewenangan.
3. Permintaan dan perbandingan penawaran vendor.
4. Purchase order atau kontrak.
5. Penerimaan material/jasa.
6. Verifikasi invoice dan syarat pembayaran.
7. Pembayaran serta pencatatan biaya aktual proyek.

Setiap tahap perlu status, penanggung jawab, timestamp, lampiran, dan audit trail. Ini relevan untuk modul procurement/actual cost yang belum lengkap.

### 3. Cost control proyek

Biaya aktual tenaga kerja, material, alat, dan subkon perlu dibandingkan dengan baseline RAB per WBS/cost code. Ringkasan proyek idealnya menampilkan anggaran, komitmen, aktual, forecast at completion, variance, dan margin.

### 4. WBS, jadwal, dan progres

Struktur proyek dapat menghubungkan WBS/BoQ dengan milestone, dependensi aktivitas, penanggung jawab, progres, dan Kurva-S rencana versus aktual. Perubahan baseline harus membuat versi baru dan tidak menimpa histori yang telah disetujui.

### 5. Progress billing

Progres terverifikasi dapat menjadi dasar berita acara atau monthly certificate, invoice termin, retensi, dan pengakuan pendapatan. Sistem perlu menjaga hubungan yang dapat ditelusuri dari item WBS hingga dokumen tagihan.

### 6. Material, alat, dan subkon

- Persediaan perlu dapat dilacak per proyek/lokasi.
- Pemakaian material harus membentuk biaya aktual pada proyek dan WBS terkait.
- Alat perlu memiliki penempatan, jam operasi, bahan bakar, downtime, dan pemeliharaan.
- Kontrak subkon perlu mendukung termin, retensi, progres, variation order, dan verifikasi dokumen.

### 7. Otomasi dan notifikasi

Peristiwa penting—permintaan persetujuan, keterlambatan, kekurangan stok, deviasi biaya, jatuh tempo, atau dokumen kedaluwarsa—dapat menghasilkan tugas/notifikasi. Otomasi tidak boleh melewati RBAC, approval, atau audit.

### 8. Dokumentasi terpusat

Kontrak, gambar, laporan inspeksi, foto lapangan, berita acara, dan dokumen pajak perlu ditautkan ke proyek/transaksi yang tepat, memiliki metadata dan versi, serta mengikuti kontrol akses.

### 9. Pelaporan

Referensi mendukung laporan lintas proyek dan drill-down ke transaksi:

- Anggaran versus komitmen versus aktual.
- Arus kas masuk/keluar dan proyeksi cash gap.
- Laba rugi dan margin per proyek.
- Umur piutang/utang, termin, dan retensi.
- Deviasi jadwal dan progres.
- Riwayat persetujuan dan audit.

## Prioritas penerapan untuk aplikasi ini

1. **Procurement dan actual cost:** PR, RFQ, evaluasi vendor, PO/SPK, penerimaan, invoice vendor, dan posting biaya ke WBS.
2. **Siklus RAB lengkap:** RAB, RAP, baseline, revisi, dan realisasi tanpa mengubah versi historis.
3. **Progress lapangan dan billing:** progres terverifikasi, berita acara, termin, retensi, dan rekonsiliasi pembayaran.
4. **Project controls:** jadwal, dependensi, Kurva-S, serta variance biaya dan waktu.
5. **Dokumen dan notifikasi:** versioning, relasi dokumen, approval inbox, dan peringatan operasional.
6. **Inventory, alat, subkon, HR/SMKK, dan integrasi regulator:** dikembangkan bertahap setelah fondasi transaksi dan cost control stabil.

## Hal yang sengaja tidak diadopsi langsung

- Nama modul, model data, atau arsitektur teknis khusus Odoo.
- Klaim persentase manfaat, biaya implementasi, dan angka komersial tanpa bukti independen.
- Materi CRM, marketing, e-commerce, POS, dan manufacturing umum yang tidak mendukung kebutuhan inti saat ini.
- Tarif pajak, regulasi, AHSP, retensi, masa berlaku, atau frekuensi sinkronisasi sebagai konstanta permanen.
- Klaim adanya API regulator tanpa verifikasi dokumentasi resmi.
- Gaya visual dan navigasi Odoo sebagai kewajiban desain.

## Aturan penggunaan

- Verifikasi regulasi dan integrasi melalui sumber resmi sebelum implementasi.
- Simpan tarif, formula, dan aturan yang berubah sebagai konfigurasi effective-dated.
- Gunakan dokumen ini untuk menyusun requirement dan acceptance criteria, bukan untuk menyalin implementasi Odoo.
- Prioritaskan kebutuhan pengguna Konstruksi Finance ERP dan pola arsitektur yang sudah ada.