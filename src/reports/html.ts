// Printable A4 reports in Khmer. The fonts (Battambang for text, Moul for headings) are embedded in each page,
// so the reports render correctly offline, and Khmer shaping is done by the browser. To get a PDF, use the
// browser's "Save as PDF" when printing.
import { readFileSync } from 'node:fs';
import { ENROLLMENT_TYPE_KM, GENDER_KM, khmerDate, khmerDigits, khmerScore, khmerToday, STUDENT_STATUS_KM } from '../constants/khmer';
import type { ClassListReport, GenderStatisticsReport, ReportCardsReport } from '../services/report.service';

const fontFace = (family: string, file: string, weight: number, unicodeRange?: string) => {
  const data = readFileSync(require.resolve(file)).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');${unicodeRange ? `unicode-range:${unicodeRange};` : ''}}`;
};
const KHMER_RANGE = 'U+1780-17FF,U+19E0-19FF,U+200C-200D,U+25CC';

// Loaded once, at first use
let fontCss: string | undefined;
const fonts = () =>
  (fontCss ??= [
    fontFace('Battambang', '@fontsource/battambang/files/battambang-khmer-400-normal.woff2', 400, KHMER_RANGE),
    fontFace('Battambang', '@fontsource/battambang/files/battambang-khmer-700-normal.woff2', 700, KHMER_RANGE),
    fontFace('Battambang', '@fontsource/battambang/files/battambang-latin-400-normal.woff2', 400),
    fontFace('Battambang', '@fontsource/battambang/files/battambang-latin-700-normal.woff2', 700),
    fontFace('Moul', '@fontsource/moul/files/moul-khmer-400-normal.woff2', 400, KHMER_RANGE),
  ].join('\n'));

/** Escapes text for HTML; every value from the database goes through this */
const h = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--ink:#111;--muted:#555;--line:#333;--soft:#e9e9e9}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:var(--ink)}
body{font-family:'Battambang',sans-serif;font-size:11pt;line-height:1.6}
.page{padding:12mm 14mm;page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
.moul{font-family:'Moul','Battambang',serif;font-weight:400}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm}
.head .kingdom{text-align:center;margin-left:auto}
.head .kingdom div:first-child{font-size:12pt}
.head .school{font-size:10pt}
.ornament{text-align:center;letter-spacing:4px;color:var(--muted);margin:1mm 0}
h1{font-family:'Moul','Battambang',serif;font-weight:400;font-size:14pt;text-align:center;margin:5mm 0 1mm}
.subtitle{text-align:center;margin-bottom:4mm}
table{width:100%;border-collapse:collapse;font-size:10pt}
th,td{border:1px solid var(--line);padding:1mm 1.5mm;vertical-align:middle}
th{background:var(--soft);font-weight:700;text-align:center}
td.c{text-align:center} td.r{text-align:right}
tr.sub td{font-size:9pt;color:var(--muted)} tr.sub td.name{padding-left:6mm}
tr.total td{font-weight:700;background:var(--soft)}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:0 10mm;margin:2mm 0 4mm}
.result{display:grid;grid-template-columns:repeat(4,1fr);gap:2mm;margin:4mm 0}
.result div{border:1px solid var(--line);padding:2mm;text-align:center}
.result b{display:block;font-size:13pt}
.remarks{border:1px solid var(--line);min-height:16mm;padding:2mm;margin-top:2mm}
.signs{display:flex;justify-content:space-between;margin-top:8mm;text-align:center;font-size:10pt}
.signs > div{min-width:55mm}
.signs .space{height:16mm}
.muted{color:var(--muted)}
@page{size:A4;margin:0}
@media print{.page{min-height:auto}}
`;

function layout(title: string, pages: string[], landscape = false) {
  return `<!doctype html>
<html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title>
<style>${fonts()}${STYLE}${landscape ? '@page{size:A4 landscape}' : ''}</style>
</head><body>${pages.join('\n')}</body></html>`;
}

type School = ClassListReport['school'];

function header(school: School) {
  return `<div class="head">
  <div class="school">
    <div class="moul">${h(school.khmerName ?? 'សាលារៀន')}</div>
    ${school.moeysCode ? `<div>លេខកូដសាលា៖ ${h(khmerDigits(school.moeysCode))}</div>` : ''}
    ${school.address ? `<div>${h(school.address)}</div>` : ''}
  </div>
  <div class="kingdom moul"><div>ព្រះរាជាណាចក្រកម្ពុជា</div><div>ជាតិ សាសនា ព្រះមហាក្សត្រ</div><div class="ornament">❀❀❀</div></div>
</div>`;
}

function signatures(left: string, right: string, rightName?: string | null) {
  return `<div class="signs">
  <div>បានឃើញ និងឯកភាព<br>${h(left)}<div class="space"></div></div>
  <div>${h(khmerToday())}<br>${h(right)}<div class="space"></div>${rightName ? h(rightName) : ''}</div>
</div>`;
}

const teacherName = (t: { khmerName: string; latinName: string } | null) => (t ? t.khmerName : null);

// ── Class list ────────────────────────────────────────────────────────────

export function classListHtml(r: ClassListReport) {
  const rows = r.students
    .map(
      (s) => `<tr>
  <td class="c">${khmerDigits(s.no)}</td><td class="c">${h(s.studentIdentifier)}</td><td>${h(s.khmerName)}</td><td>${h(s.latinName)}</td>
  <td class="c">${GENDER_KM[s.gender]}</td><td class="c">${khmerDate(s.dateOfBirth)}</td>
  <td class="c">${ENROLLMENT_TYPE_KM[s.enrollmentType]}</td><td class="c">${STUDENT_STATUS_KM[s.status]}</td>
</tr>`,
    )
    .join('');
  const page = `<section class="page">
${header(r.school)}
<h1>បញ្ជីឈ្មោះសិស្ស ថ្នាក់ទី${khmerDigits(r.classSection.name)}</h1>
<div class="subtitle">ឆ្នាំសិក្សា ${khmerDigits(r.classSection.academicYear.name)}${r.classSection.homeroomTeacher ? ` · គ្រូបន្ទុកថ្នាក់៖ ${h(r.classSection.homeroomTeacher.khmerName)}` : ''}</div>
<table>
  <thead><tr><th>ល.រ</th><th>អត្តលេខ</th><th>គោត្តនាម និងនាម</th><th>ឈ្មោះជាអក្សរឡាតាំង</th><th>ភេទ</th><th>ថ្ងៃខែឆ្នាំកំណើត</th><th>ការចុះឈ្មោះ</th><th>ស្ថានភាព</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>សិស្សសរុប ${khmerDigits(r.summary.total)} នាក់ ស្រី ${khmerDigits(r.summary.female)} នាក់ · កំពុងសិក្សា ${khmerDigits(r.summary.active)} នាក់ ស្រី ${khmerDigits(r.summary.activeFemale)} នាក់</p>
${signatures('នាយកសាលា', 'គ្រូបន្ទុកថ្នាក់', teacherName(r.classSection.homeroomTeacher))}
</section>`;
  return layout(`បញ្ជីឈ្មោះសិស្ស ${r.classSection.name} ${r.classSection.academicYear.name}`, [page]);
}

// ── Gender statistics ─────────────────────────────────────────────────────

const STAT_HEADINGS: Record<GenderStatisticsReport['columns'][number], string> = {
  enrolled: 'សិស្សចុះឈ្មោះ',
  newAdmissions: 'ចូលរៀនថ្មី',
  promoted: 'ឡើងថ្នាក់',
  repeating: 'ត្រួតថ្នាក់',
  droppedOut: 'បោះបង់ការសិក្សា',
  graduated: 'បញ្ចប់ការសិក្សា',
  active: 'នៅសល់ (កំពុងសិក្សា)',
};

export function genderStatisticsHtml(r: GenderStatisticsReport) {
  type Row = GenderStatisticsReport['total'];
  const cells = (row: Row) => r.columns.map((c) => `<td class="c">${khmerDigits(row[c].total)}</td><td class="c">${khmerDigits(row[c].female)}</td>`).join('');
  const body = r.grades
    .map(
      (g) =>
        g.classes.map((c) => `<tr><td class="c">${khmerDigits(c.name)}</td>${cells(c)}</tr>`).join('') +
        `<tr class="total"><td class="c">សរុបថ្នាក់ទី${khmerDigits(g.gradeNumber)}</td>${cells(g.total)}</tr>`,
    )
    .join('');
  const page = `<section class="page">
${header(r.school)}
<h1>ស្ថិតិសិស្ស តាមភេទ</h1>
<div class="subtitle">ឆ្នាំសិក្សា ${khmerDigits(r.academicYear.name)}</div>
<table>
  <thead>
    <tr><th rowspan="2">ថ្នាក់</th>${r.columns.map((c) => `<th colspan="2">${STAT_HEADINGS[c]}</th>`).join('')}</tr>
    <tr>${r.columns.map(() => '<th>សរុប</th><th>ស្រី</th>').join('')}</tr>
  </thead>
  <tbody>${body}<tr class="total"><td class="c">សរុបរួម</td>${cells(r.total)}</tr></tbody>
</table>
<p class="muted">សិស្សចុះឈ្មោះ = ចូលរៀនថ្មី + ឡើងថ្នាក់ + ត្រួតថ្នាក់ · នៅសល់ = សិស្សចុះឈ្មោះ − បោះបង់ការសិក្សា − បញ្ចប់ការសិក្សា</p>
${signatures('ប្រធានការិយាល័យអប់រំ', 'នាយកសាលា')}
</section>`;
  return layout(`ស្ថិតិសិស្ស តាមភេទ ${r.academicYear.name}`, [page], true);
}

// ── Report cards ──────────────────────────────────────────────────────────

export function reportCardsHtml(r: ReportCardsReport) {
  const pages = r.cards.map((card) => {
    const rows = card.subjects
      .map(
        (s, i) =>
          `<tr><td class="c">${khmerDigits(i + 1)}</td><td>${h(s.khmerName)}</td><td class="c">${khmerScore(s.maxScore)}</td><td class="c">${s.score === null ? '—' : khmerScore(s.score)}</td></tr>` +
          s.components
            .map(
              (k) =>
                `<tr class="sub"><td></td><td class="name">${h(k.name)}</td><td class="c">${khmerScore(k.maxScore)}</td><td class="c">${k.score === null ? '—' : khmerScore(k.score)}</td></tr>`,
            )
            .join(''),
      )
      .join('');
    return `<section class="page">
${header(r.school)}
<h1>ព្រឹត្តិបត្រពិន្ទុ</h1>
<div class="subtitle">${h(r.assessmentPeriod.name)} · ឆ្នាំសិក្សា ${khmerDigits(r.assessmentPeriod.academicYear)}</div>
<div class="facts">
  <div>គោត្តនាម និងនាម៖ <b>${h(card.student.khmerName)}</b> (${h(card.student.latinName)})</div>
  <div>អត្តលេខ៖ ${h(card.student.studentIdentifier)}</div>
  <div>ភេទ៖ ${GENDER_KM[card.student.gender]} · ថ្ងៃខែឆ្នាំកំណើត៖ ${khmerDate(card.student.dateOfBirth)}</div>
  <div>ថ្នាក់ទី៖ ${khmerDigits(r.classSection.name)}</div>
</div>
<table>
  <thead><tr><th>ល.រ</th><th>មុខវិជ្ជា</th><th>ពិន្ទុអតិបរមា</th><th>ពិន្ទុទទួលបាន</th></tr></thead>
  <tbody>${rows}<tr class="total"><td></td><td>ពិន្ទុសរុប</td><td class="c">${khmerScore(r.maxTotal)}</td><td class="c">${khmerScore(card.totalScore)}</td></tr></tbody>
</table>
<div class="result">
  <div>មធ្យមភាគ<b>${khmerScore(card.average)}%</b></div>
  <div>និទ្ទេស<b>${h(card.mention)} · ${h(card.mentionKhmer)}</b></div>
  <div>ចំណាត់ថ្នាក់<b>${khmerDigits(card.classRank)} / ${khmerDigits(r.classSize)}</b></div>
  <div>លទ្ធផល<b>${card.mention === 'F' ? 'ធ្លាក់' : 'ជាប់'}</b></div>
</div>
<div>មតិយោបល់របស់គ្រូបន្ទុកថ្នាក់៖</div>
<div class="remarks">${h(card.remarks ?? '')}</div>
<div class="signs">
  <div>ហត្ថលេខាមាតាបិតា ឬអាណាព្យាបាល<div class="space"></div></div>
  <div>បានឃើញ និងឯកភាព<br>នាយកសាលា<div class="space"></div></div>
  <div>${h(khmerToday())}<br>គ្រូបន្ទុកថ្នាក់<div class="space"></div>${h(teacherName(r.classSection.homeroomTeacher) ?? '')}</div>
</div>
</section>`;
  });
  return layout(`ព្រឹត្តិបត្រពិន្ទុ ${r.classSection.name} ${r.assessmentPeriod.name} ${r.assessmentPeriod.academicYear}`, pages);
}
