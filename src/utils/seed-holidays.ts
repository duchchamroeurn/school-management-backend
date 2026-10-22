// Imports Cambodian public holidays (ថ្ងៃឈប់សម្រាកសាធារណៈ) into the school calendar from a JSON file
// (default: data/public.holiday.json), through the same service as POST /calendar/events.
//
//   npm run db:seed:holidays                       # validate + import
//   npm run db:seed:holidays -- --dry-run          # validate only
//   npm run db:seed:holidays -- path/to/file.json
//
// File: { "holidays": [{ "year": 2026, "date": "2026-04-14", "day_of_week": "Tuesday", "name": "Khmer New Year (Day 1)", "khmerName"?: "…" }] }
// (a plain array of entries works too). Each entry becomes a one-day PUBLIC_HOLIDAY, which closes the school.
// They are not marked recursYearly: the file lists every year's dates, and lunar holidays move each year.
//
// The calendar needs a Khmer name; well-known holidays get theirs from KHMER_NAMES below, or set "khmerName"
// on the entry. Entries whose date + name are already in the calendar are skipped, so it can be re-run.
import { CalendarEventType } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { CalendarEventInput, createEvent } from '../services/calendar.service';
import { isoDate } from './dates';
import { runImport } from './import-runner';
import { optionalDate, optionalKhmerName, optionalString, required } from './validate';

// English name in the file → Khmer name. "(Day 1)" … "(Day 3)" suffixes are matched separately.
const KHMER_NAMES: Record<string, string> = {
  "International New Year's Day": 'ទិវាចូលឆ្នាំសកល',
  'Victory over Genocide Day': 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍',
  "International Women's Day": 'ទិវានារីអន្តរជាតិ',
  'Khmer New Year': 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ',
  'International Labor Day': 'ទិវាពលកម្មអន្តរជាតិ',
  'Royal Ploughing Ceremony': 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល',
  'Visak Bochea Day': 'ពិធីបុណ្យវិសាខបូជា',
  "King Norodom Sihamoni's Birthday": 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះករុណា ព្រះបាទសម្តេចព្រះបរមនាថ នរោត្តម សីហមុនី',
  "Queen Mother's Birthday": 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះមហាក្សត្រី នរោត្តម មុនិនាថ សីហនុ',
  'Constitution Day': 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ',
  'Pchum Ben Festival': 'ពិធីបុណ្យភ្ជុំបិណ្ឌ',
  'Commemoration of the Late King Father': 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណា ព្រះបាទសម្តេចព្រះ នរោត្តម សីហនុ ព្រះបរមរតនកោដ្ឋ',
  "King Norodom Sihamoni's Coronation Day": 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ ព្រះករុណា ព្រះបាទសម្តេចព្រះបរមនាថ នរោត្តម សីហមុនី',
  'Independence Day': 'ពិធីបុណ្យឯករាជ្យជាតិ',
  'Water Festival / Bon Om Touk': 'ព្រះរាជពិធីបុណ្យអុំទូក បណ្តែតប្រទីប និងសំពះព្រះខែ អកអំបុក',
  'Peace Day': 'ទិវាសន្តិភាពនៅកម្ពុជា',
};

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
const toKhmerDigits = (n: string) => n.replace(/[0-9]/g, (d) => KHMER_DIGITS[Number(d)]);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Pchum Ben Festival (Day 2)" → "ពិធីបុណ្យភ្ជុំបិណ្ឌ ថ្ងៃទី២"; undefined when the holiday isn't known */
function khmerNameFor(name: string): string | undefined {
  const day = /^(.*) \(Day (\d+)\)$/.exec(name);
  const base = KHMER_NAMES[day ? day[1] : name];
  return base && (day ? `${base} ថ្ងៃទី${toKhmerDigits(day[2])}` : base);
}

const keyOf = (date: Date, latinName: string) => `${isoDate(date)} ${latinName}`;

runImport({
  label: 'public holiday',
  defaultFile: 'data/public.holiday.json',
  keyName: 'date + name',
  entriesOf: (json) => (Array.isArray(json) ? json : (json as { holidays?: unknown })?.holidays),
  labelOf: (raw) => `${raw.date ?? ''} ${raw.name ?? ''}`,
  toInput: (raw): CalendarEventInput => {
    const name = required(optionalString(raw.name, 'name'), 'name');
    const date = required(optionalDate(raw.date, 'date'), 'date');
    // Catch typos in the file: year and day_of_week, when given, must agree with the date
    if (raw.year !== undefined && raw.year !== date.getUTCFullYear()) throw new Error(`year ${raw.year} does not match date ${isoDate(date)}`);
    const weekday = WEEKDAYS[date.getUTCDay()];
    if (raw.day_of_week !== undefined && raw.day_of_week !== weekday) {
      throw new Error(`day_of_week "${raw.day_of_week}" does not match ${isoDate(date)}, which is a ${weekday}`);
    }
    const khmerName = optionalKhmerName(raw.khmerName) ?? khmerNameFor(name);
    if (!khmerName) throw new Error(`no Khmer name known for "${name}" — add "khmerName" to this entry`);
    return { type: CalendarEventType.PUBLIC_HOLIDAY, khmerName, latinName: name, startDate: date, endDate: date };
  },
  keyOf: (input) => keyOf(input.startDate, input.latinName!),
  findExisting: async (keys) => {
    const dates = [...new Set(keys.map((k) => new Date(`${k.slice(0, 10)}T00:00:00.000Z`)))];
    const existing = await prisma.calendarEvent.findMany({
      where: { type: CalendarEventType.PUBLIC_HOLIDAY, startDate: { in: dates } },
      select: { startDate: true, latinName: true, khmerName: true },
    });
    return new Map(existing.map((e) => [keyOf(e.startDate, e.latinName ?? ''), `${e.khmerName}`]));
  },
  create: createEvent,
  describe: (e) => `${isoDate(e.startDate)}  ${e.latinName}  —  ${e.khmerName}`,
});
