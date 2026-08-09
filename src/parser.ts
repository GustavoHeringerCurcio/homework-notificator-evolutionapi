import { Config, ScraperResult } from './types';

export function extractHomeworks(
  items: { locator: (selector: string) => { textContent: () => Promise<string | null> } }[],
  selectors: Config,
): { title: string; due_date: string; due_time: string | null }[] {
  return [];
}

export function parseDate(raw: string): string | null {
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return raw;

  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;

  const textMatch = raw.match(/(\d{1,2})\s*de\s*(\w+)\s*de\s*(\d{4})/i);
  if (textMatch) {
    const months: Record<string, string> = {
      'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03',
      'abril': '04', 'maio': '05', 'junho': '06',
      'julho': '07', 'agosto': '08', 'setembro': '09',
      'outubro': '10', 'novembro': '11', 'dezembro': '12',
    };
    const monthKey = textMatch[2].toLowerCase().replace(/ç/g, 'c');
    const month = months[monthKey];
    if (month) {
      const day = textMatch[1].padStart(2, '0');
      return `${textMatch[3]}-${month}-${day}`;
    }
  }

  return null;
}
