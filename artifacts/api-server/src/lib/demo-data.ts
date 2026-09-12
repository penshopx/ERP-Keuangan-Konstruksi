export type ProjectRecord = {
  id: string;
  code: string;
  name: string;
  owner: string;
  contractValue: number;
  budget: number;
  actualCost: number;
  progress: number;
  status: string;
  health: string;
  endDate: string;
};

export type InvoiceRecord = {
  id: string;
  number: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  period: string;
  dpp: number;
  ppn: number;
  pphFinal: number;
  retention: number;
  total: number;
  status: string;
  issuedAt: string;
};

export const projects: ProjectRecord[] = [
  {
    id: "prj-001",
    code: "GKT-025",
    name: "Gedung Kantor Terpadu",
    owner: "PT Sentra Properti Nusantara",
    contractValue: 48_500_000_000,
    budget: 39_200_000_000,
    actualCost: 20_860_000_000,
    progress: 58,
    status: "BERJALAN",
    health: "SEHAT",
    endDate: "2027-03-28",
  },
  {
    id: "prj-002",
    code: "JBT-014",
    name: "Jembatan Akses Timur",
    owner: "Dinas PUPR Kota Surabaya",
    contractValue: 27_800_000_000,
    budget: 23_400_000_000,
    actualCost: 17_420_000_000,
    progress: 72,
    status: "BERJALAN",
    health: "PERHATIAN",
    endDate: "2026-12-15",
  },
  {
    id: "prj-003",
    code: "RSU-008",
    name: "Renovasi RS Umum Mandala",
    owner: "Yayasan Mandala Sehat",
    contractValue: 16_250_000_000,
    budget: 13_100_000_000,
    actualCost: 9_280_000_000,
    progress: 81,
    status: "BERJALAN",
    health: "SEHAT",
    endDate: "2026-11-10",
  },
  {
    id: "prj-004",
    code: "WHB-031",
    name: "Warehouse Balaraja",
    owner: "PT Logistik Cipta Raya",
    contractValue: 21_600_000_000,
    budget: 17_900_000_000,
    actualCost: 2_150_000_000,
    progress: 14,
    status: "PERSIAPAN",
    health: "SEHAT",
    endDate: "2027-08-30",
  },
];

export const invoices: InvoiceRecord[] = [
  {
    id: "inv-001",
    number: "INV/GKT/IX/2026/004",
    projectId: "prj-001",
    projectCode: "GKT-025",
    projectName: "Gedung Kantor Terpadu",
    period: "Termin 4 · Agustus 2026",
    dpp: 4_850_000_000,
    ppn: 146_712_500,
    pphFinal: 121_250_000,
    retention: 242_500_000,
    total: 4_632_962_500,
    status: "MENUNGGU PEMBAYARAN",
    issuedAt: "2026-09-03",
  },
  {
    id: "inv-002",
    number: "INV/JBT/IX/2026/006",
    projectId: "prj-002",
    projectCode: "JBT-014",
    projectName: "Jembatan Akses Timur",
    period: "Termin 6 · Agustus 2026",
    dpp: 2_780_000_000,
    ppn: 99_385_000,
    pphFinal: 69_500_000,
    retention: 139_000_000,
    total: 2_670_885_000,
    status: "DITERBITKAN",
    issuedAt: "2026-09-08",
  },
  {
    id: "inv-003",
    number: "INV/RSU/VIII/2026/007",
    projectId: "prj-003",
    projectCode: "RSU-008",
    projectName: "Renovasi RS Umum Mandala",
    period: "Termin 7 · Juli 2026",
    dpp: 1_625_000_000,
    ppn: 58_093_750,
    pphFinal: 40_625_000,
    retention: 81_250_000,
    total: 1_561_218_750,
    status: "LUNAS",
    issuedAt: "2026-08-02",
  },
];

export const rabItems = [
  { id: "rab-01", code: "1.1", name: "Mobilisasi dan persiapan", category: "OVERHEAD", budget: 1_850_000_000, committed: 1_720_000_000, actual: 1_680_000_000 },
  { id: "rab-02", code: "2.1", name: "Pekerjaan pondasi", category: "MATERIAL", budget: 7_200_000_000, committed: 6_890_000_000, actual: 6_420_000_000 },
  { id: "rab-03", code: "2.2", name: "Struktur beton", category: "MATERIAL", budget: 13_600_000_000, committed: 11_980_000_000, actual: 8_750_000_000 },
  { id: "rab-04", code: "3.1", name: "Arsitektur dan finishing", category: "SUBKON", budget: 9_450_000_000, committed: 6_150_000_000, actual: 2_140_000_000 },
  { id: "rab-05", code: "4.1", name: "MEP dan utilitas", category: "SUBKON", budget: 7_100_000_000, committed: 4_820_000_000, actual: 1_870_000_000 },
];

export const activity = [
  { id: "act-01", action: "DISETUJUI", entity: "Invoice", detail: "Termin 6 JBT-014 disetujui Finance Manager", user: "Nadia Putri", timestamp: "2026-09-12T09:42:00+07:00", tone: "success" },
  { id: "act-02", action: "DIPOSTING", entity: "Jurnal", detail: "Jurnal biaya proyek GKT-025 periode Agustus", user: "Rizky Mahendra", timestamp: "2026-09-12T08:18:00+07:00", tone: "info" },
  { id: "act-03", action: "PERINGATAN", entity: "Anggaran", detail: "WBS 2.1 JBT-014 mencapai 94% komitmen", user: "Sistem", timestamp: "2026-09-11T16:05:00+07:00", tone: "warning" },
  { id: "act-04", action: "DIPERBARUI", entity: "RAB", detail: "Baseline RAB WHB-031 versi 2 diajukan", user: "Fajar Nugroho", timestamp: "2026-09-11T13:24:00+07:00", tone: "neutral" },
  { id: "act-05", action: "DIREKONSILIASI", entity: "Pajak", detail: "PPN masa Agustus cocok 99,8% dengan buku", user: "Siska Amelia", timestamp: "2026-09-11T10:50:00+07:00", tone: "success" },
];

export function projectDetail(project: ProjectRecord) {
  const projectInvoices = invoices.filter((invoice) => invoice.projectId === project.id);
  const utilization = project.budget === 0 ? 0 : (project.actualCost / project.budget) * 100;
  return {
    ...project,
    wbsCount: project.id === "prj-001" ? 34 : 22,
    budgetUtilization: Number(utilization.toFixed(1)),
    spi: project.id === "prj-002" ? 0.88 : 1.04,
    cpi: project.id === "prj-002" ? 0.91 : 1.08,
    recentInvoices: projectInvoices,
  };
}