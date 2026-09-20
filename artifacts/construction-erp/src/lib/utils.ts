import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

const INDONESIA_TIME_ZONE = 'Asia/Jakarta';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

export function formatDate(dateString: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: INDONESIA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}
