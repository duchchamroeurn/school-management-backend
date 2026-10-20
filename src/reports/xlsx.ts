// Excel versions of the reports, e.g. for sending statistics to the district office. Cells hold real numbers
// and dates (Arabic digits) so they can be summed and filtered; labels are in Khmer.
import ExcelJS from 'exceljs';
import { mentionInfo } from '../constants/grading';
import { ENROLLMENT_TYPE_KM, GENDER_KM, STUDENT_STATUS_KM } from '../constants/khmer';
import type { ClassListReport, GenderStatisticsReport, ReportCardsReport } from '../services/report.service';

// Installed on most Khmer-language Windows PCs; Excel falls back to another font otherwise
const FONT = 'Khmer OS Battambang';
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

function sheet(workbook: ExcelJS.Workbook, name: string, title: string, subtitle: string, columnCount: number, landscape = false) {
  const ws = workbook.addWorksheet(name, { pageSetup: { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.properties.defaultRowHeight = 20;
  for (const [row, text, size] of [[1, title, 14], [2, subtitle, 11]] as const) {
    ws.mergeCells(row, 1, row, columnCount);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { name: FONT, size, bold: row === 1 };
    cell.alignment = { horizontal: 'center' };
  }
  return ws;
}

function headerRow(ws: ExcelJS.Worksheet, rowNumber: number, labels: string[]) {
  const row = ws.getRow(rowNumber);
  labels.forEach((label, i) => (row.getCell(i + 1).value = label));
  styleRow(row, labels.length, { bold: true, fill: true });
}

function styleRow(row: ExcelJS.Row, columnCount: number, { bold = false, fill = false } = {}) {
  for (let i = 1; i <= columnCount; i++) {
    const cell = row.getCell(i);
    cell.font = { name: FONT, size: 10, bold };
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'center' : 'left', wrapText: true };
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E9E9' } };
  }
}

const toBuffer = async (workbook: ExcelJS.Workbook) => Buffer.from(await workbook.xlsx.writeBuffer());

const schoolLine = (school: ClassListReport['school']) => [school.khmerName, school.moeysCode && `លេខកូដ ${school.moeysCode}`].filter(Boolean).join(' · ');

export async function classListXlsx(r: ClassListReport) {
  const workbook = new ExcelJS.Workbook();
  const labels = ['ល.រ', 'អត្តលេខ', 'គោត្តនាម និងនាម', 'ឈ្មោះឡាតាំង', 'ភេទ', 'ថ្ងៃខែឆ្នាំកំណើត', 'ការចុះឈ្មោះ', 'ស្ថានភាព'];
  const ws = sheet(workbook, r.classSection.name, `បញ្ជីឈ្មោះសិស្ស ថ្នាក់ទី${r.classSection.name}`, `${schoolLine(r.school)} · ឆ្នាំសិក្សា ${r.classSection.academicYear.name}`, labels.length);
  headerRow(ws, 4, labels);
  r.students.forEach((s, i) => {
    const row = ws.getRow(5 + i);
    row.values = [s.no, s.studentIdentifier, s.khmerName, s.latinName, GENDER_KM[s.gender], s.dateOfBirth, ENROLLMENT_TYPE_KM[s.enrollmentType], STUDENT_STATUS_KM[s.status]];
    row.getCell(6).numFmt = 'dd/mm/yyyy';
    styleRow(row, labels.length);
  });
  const summary = ws.getRow(6 + r.students.length);
  summary.getCell(1).value = `សិស្សសរុប ${r.summary.total} នាក់ ស្រី ${r.summary.female} នាក់ · កំពុងសិក្សា ${r.summary.active} នាក់ ស្រី ${r.summary.activeFemale} នាក់`;
  summary.getCell(1).font = { name: FONT, size: 10 };
  ws.columns.forEach((c, i) => (c.width = [6, 14, 24, 24, 7, 14, 14, 16][i]));
  return toBuffer(workbook);
}

const STAT_LABELS: Record<GenderStatisticsReport['columns'][number], string> = {
  enrolled: 'សិស្សចុះឈ្មោះ',
  newAdmissions: 'ចូលរៀនថ្មី',
  promoted: 'ឡើងថ្នាក់',
  repeating: 'ត្រួតថ្នាក់',
  droppedOut: 'បោះបង់',
  graduated: 'បញ្ចប់ការសិក្សា',
  active: 'នៅសល់',
};

export async function genderStatisticsXlsx(r: GenderStatisticsReport) {
  const workbook = new ExcelJS.Workbook();
  const columnCount = 1 + r.columns.length * 2;
  const ws = sheet(workbook, r.academicYear.name, 'ស្ថិតិសិស្ស តាមភេទ', `${schoolLine(r.school)} · ឆ្នាំសិក្សា ${r.academicYear.name}`, columnCount, true);
  // Two header rows: the figure, then សរុប / ស្រី under it
  ws.mergeCells(4, 1, 5, 1);
  ws.getCell(4, 1).value = 'ថ្នាក់';
  r.columns.forEach((c, i) => {
    ws.mergeCells(4, 2 + i * 2, 4, 3 + i * 2);
    ws.getCell(4, 2 + i * 2).value = STAT_LABELS[c];
    ws.getCell(5, 2 + i * 2).value = 'សរុប';
    ws.getCell(5, 3 + i * 2).value = 'ស្រី';
  });
  styleRow(ws.getRow(4), columnCount, { bold: true, fill: true });
  styleRow(ws.getRow(5), columnCount, { bold: true, fill: true });

  type Row = GenderStatisticsReport['total'];
  let rowNumber = 6;
  const add = (label: string, row: Row, bold = false) => {
    const r2 = ws.getRow(rowNumber++);
    r2.values = [label, ...r.columns.flatMap((c) => [row[c].total, row[c].female])];
    styleRow(r2, columnCount, { bold, fill: bold });
  };
  for (const g of r.grades) {
    for (const c of g.classes) add(c.name, c);
    add(`សរុបថ្នាក់ទី${g.gradeNumber}`, g.total, true);
  }
  add('សរុបរួម', r.total, true);
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 16 : 9));
  return toBuffer(workbook);
}

/** One sheet ranking the class: every student's subject scores, total, average, mention and rank */
export async function reportCardsXlsx(r: ReportCardsReport) {
  const workbook = new ExcelJS.Workbook();
  const subjects = r.cards[0]?.subjects ?? [];
  const labels = ['ចំណាត់ថ្នាក់', 'អត្តលេខ', 'គោត្តនាម និងនាម', 'ភេទ', ...subjects.map((s) => `${s.khmerName} (${s.maxScore})`), `សរុប (${r.maxTotal})`, 'មធ្យមភាគ %', 'និទ្ទេស'];
  const ws = sheet(
    workbook,
    r.classSection.name,
    `តារាងពិន្ទុ ថ្នាក់ទី${r.classSection.name} · ${r.assessmentPeriod.name}`,
    `${schoolLine(r.school)} · ឆ្នាំសិក្សា ${r.assessmentPeriod.academicYear}`,
    labels.length,
    true,
  );
  headerRow(ws, 4, labels);
  r.cards.forEach((card, i) => {
    const row = ws.getRow(5 + i);
    row.values = [
      card.classRank,
      card.student.studentIdentifier,
      card.student.khmerName,
      GENDER_KM[card.student.gender],
      ...card.subjects.map((s) => s.score),
      card.totalScore,
      card.average,
      `${card.mention} ${mentionInfo(card.mention).khmer}`,
    ];
    styleRow(row, labels.length);
  });
  ws.columns.forEach((c, i) => (c.width = i === 2 ? 24 : i === 1 ? 14 : 10));
  return toBuffer(workbook);
}
