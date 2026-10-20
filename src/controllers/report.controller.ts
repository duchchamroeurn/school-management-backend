import { Request, Response } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import { classListHtml, genderStatisticsHtml, reportCardsHtml } from '../reports/html';
import { classListXlsx, genderStatisticsXlsx, reportCardsXlsx } from '../reports/xlsx';
import * as reportService from '../services/report.service';
import { optionalEnum, queryString, required } from '../utils/validate';

const FORMATS = ['json', 'html', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

const formatOf = (req: Request): Format => optionalEnum(queryString(req.query.format, 'format'), 'format', FORMATS) ?? 'json';

// Download names stay ASCII (the class and year are enough to tell files apart)
const safeName = (name: string) => name.replace(/[^\w.-]+/g, '-');

/** Sends report data as JSON, a printable HTML page or an Excel file, depending on ?format= */
async function send<T>(
  req: Request,
  res: Response,
  data: T,
  render: { html: (data: T) => string; xlsx: (data: T) => Promise<Buffer>; fileName: string },
) {
  const format = formatOf(req);
  const fileName = safeName(render.fileName);
  switch (format) {
    case 'json':
      res.json({ status: 'success', data });
      return;
    case 'html':
      res.type('html').send(render.html(data));
      return;
    case 'xlsx':
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .setHeader('Content-Disposition', `attachment; filename="${fileName}.xlsx"`)
        .send(await render.xlsx(data));
  }
}

// GET /api/v1/reports/class-list/:classSectionId?format=json|html|xlsx
export async function classList(req: Request<{ classSectionId: string }>, res: Response) {
  const data = await reportService.getClassList(req.params.classSectionId);
  await send(req, res, data, {
    html: classListHtml,
    xlsx: classListXlsx,
    fileName: `class-list-${data.classSection.name}-${data.classSection.academicYear.name}`,
  });
}

// GET /api/v1/reports/gender-statistics?academicYearId=&format= (defaults to the ACTIVE year)
export async function genderStatistics(req: Request, res: Response) {
  const data = await reportService.getGenderStatistics(queryString(req.query.academicYearId, 'academicYearId'));
  await send(req, res, data, {
    html: genderStatisticsHtml,
    xlsx: genderStatisticsXlsx,
    fileName: `gender-statistics-${data.academicYear.name}`,
  });
}

// GET /api/v1/reports/report-cards/:classSectionId?assessmentPeriodId=&studentId=&format=
// One card per student (or only studentId). xlsx gives the class's ranked score sheet instead of cards.
export async function reportCards(req: Request<{ classSectionId: string }>, res: Response) {
  const viewer = { staffProfileId: req.user!.staffProfileId, canViewAny: req.user!.permissions.includes(PERMISSIONS.REPORT_CARD.VIEW_ANY) };
  const data = await reportService.getReportCards(
    viewer,
    req.params.classSectionId,
    required(queryString(req.query.assessmentPeriodId, 'assessmentPeriodId'), 'assessmentPeriodId'),
    queryString(req.query.studentId, 'studentId'),
  );
  await send(req, res, data, {
    html: reportCardsHtml,
    xlsx: reportCardsXlsx,
    fileName: `report-cards-${data.classSection.name}-${data.assessmentPeriod.name}-${data.assessmentPeriod.academicYear}`,
  });
}
