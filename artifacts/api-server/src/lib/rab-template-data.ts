import { db, rabTemplatesTable, type RabTemplateItemData } from "@workspace/db";

type TemplateSeed = {
  id: string;
  name: string;
  projectType: string;
  description: string;
  sourceNote: string;
  items: RabTemplateItemData[];
};

const item = (
  code: string,
  name: string,
  category: string,
  unit: string,
  quantity: number,
  unitPrice: number,
  materialCost: number,
  laborCost: number,
  equipmentCost: number,
  parentCode: string | null = null,
  level = 1,
): RabTemplateItemData => ({
  code, name, category, unit, quantity, unitPrice, materialCost, laborCost, equipmentCost, parentCode, level,
});

export const rabTemplateSeeds: TemplateSeed[] = [
  {
    id: "tpl-gedung-standar",
    name: "Gedung Bertingkat — Struktur & Arsitektur",
    projectType: "GEDUNG",
    description: "Kerangka awal RAB gedung dari pekerjaan persiapan sampai MEP dan finishing.",
    sourceNote: "Disusun dari pola WBS Modul RAB, Materi RAB, DED/RKS/RAB, dan contoh estimasi biaya yang diunggah. Harga hanya referensi awal dan wajib disesuaikan lokasi serta periode.",
    items: [
      item("1.1", "Mobilisasi, direksi keet, dan pengukuran", "PERSIAPAN", "ls", 1, 125_000_000, 45_000_000, 55_000_000, 25_000_000),
      item("2.1", "Galian tanah pondasi", "TANAH", "m3", 450, 185_000, 15_000, 95_000, 75_000),
      item("2.2", "Pondasi beton bertulang", "STRUKTUR", "m3", 210, 6_850_000, 4_850_000, 1_250_000, 750_000),
      item("3.1", "Kolom, balok, dan pelat beton", "STRUKTUR", "m3", 680, 7_150_000, 5_050_000, 1_350_000, 750_000),
      item("4.1", "Dinding bata ringan dan plester", "ARSITEKTUR", "m2", 3_200, 425_000, 265_000, 140_000, 20_000),
      item("4.2", "Lantai, plafon, dan pengecatan", "FINISHING", "m2", 4_800, 565_000, 390_000, 155_000, 20_000),
      item("5.1", "Instalasi mekanikal, elektrikal, dan plumbing", "MEP", "ls", 1, 2_850_000_000, 1_950_000_000, 520_000_000, 380_000_000),
    ],
  },
  {
    id: "tpl-jalan-lentur",
    name: "Jalan Perkerasan Lentur",
    projectType: "JALAN",
    description: "Template pekerjaan jalan dari persiapan badan jalan sampai lapis aspal dan drainase.",
    sourceNote: "Disusun dari RAB jalan, modul perencanaan proyek, dan kumpulan contoh RAB yang diunggah. Volume dan harga adalah contoh untuk penyesuaian proyek.",
    items: [
      item("1.1", "Mobilisasi dan manajemen lalu lintas", "PERSIAPAN", "ls", 1, 95_000_000, 25_000_000, 35_000_000, 35_000_000),
      item("2.1", "Pembersihan dan penyiapan badan jalan", "TANAH", "m2", 6_000, 18_500, 2_500, 7_000, 9_000),
      item("2.2", "Timbunan pilihan dan pemadatan", "TANAH", "m3", 1_350, 285_000, 185_000, 35_000, 65_000),
      item("3.1", "Lapis pondasi agregat kelas A", "PERKERASAN", "m3", 950, 615_000, 455_000, 45_000, 115_000),
      item("3.2", "Lapis resap pengikat", "PERKERASAN", "liter", 7_200, 24_500, 18_500, 2_500, 3_500),
      item("3.3", "Asphalt concrete wearing course", "PERKERASAN", "ton", 780, 1_485_000, 1_180_000, 85_000, 220_000),
      item("4.1", "Saluran drainase pracetak", "DRAINASE", "m", 1_200, 785_000, 585_000, 145_000, 55_000),
    ],
  },
  {
    id: "tpl-rumah-sederhana",
    name: "Rumah Tinggal Sederhana",
    projectType: "RUMAH",
    description: "Template ringkas rumah tinggal untuk estimasi awal struktur, arsitektur, dan utilitas.",
    sourceNote: "Disusun dari RAB rumah minimalis, Contoh RAB, dan materi konsep umum RAB yang diunggah. Bukan basis harga pasar terkini.",
    items: [
      item("1.1", "Pembersihan lahan dan bouwplank", "PERSIAPAN", "ls", 1, 12_500_000, 4_000_000, 6_500_000, 2_000_000),
      item("2.1", "Pondasi batu kali", "STRUKTUR", "m3", 28, 1_285_000, 885_000, 340_000, 60_000),
      item("2.2", "Sloof, kolom, dan ring balok", "STRUKTUR", "m3", 16, 6_450_000, 4_650_000, 1_450_000, 350_000),
      item("3.1", "Dinding, plester, dan acian", "ARSITEKTUR", "m2", 420, 385_000, 235_000, 135_000, 15_000),
      item("3.2", "Rangka dan penutup atap", "ARSITEKTUR", "m2", 180, 675_000, 495_000, 145_000, 35_000),
      item("4.1", "Lantai, plafon, pintu, dan pengecatan", "FINISHING", "m2", 220, 725_000, 510_000, 195_000, 20_000),
      item("5.1", "Instalasi listrik dan plumbing", "MEP", "ls", 1, 85_000_000, 58_000_000, 22_000_000, 5_000_000),
    ],
  },
];

export async function seedRabTemplates() {
  for (const template of rabTemplateSeeds) {
    await db.insert(rabTemplatesTable).values(template).onConflictDoUpdate({
      target: rabTemplatesTable.id,
      set: {
        name: template.name,
        projectType: template.projectType,
        description: template.description,
        sourceNote: template.sourceNote,
        items: template.items,
      },
    });
  }
}