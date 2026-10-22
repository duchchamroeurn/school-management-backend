// The gazetteer: provinces › districts › communes › villages, with official NCDD codes. Read-only through the
// API (it is imported with `npm run db:seed:gazetteer`). Also formats addresses the way the registry writes them:
//   ភូមិអូរធំ ឃុំបន្ទាយនាង ស្រុកមង្គលបូរី ខេត្តបន្ទាយមានជ័យ
//   Ou Thum Village, Banteay Neang Commune, Mongkol Borey District, Banteay Meanchey Province
import { Errors } from '../constants/errors';
import { CommuneType, DistrictType, Prisma, ProvinceType } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

export const LEVEL_PREFIX = {
  province: { [ProvinceType.PROVINCE]: { km: 'ខេត្ត', en: 'Province' }, [ProvinceType.CAPITAL]: { km: 'រាជធានី', en: 'Capital' } },
  district: {
    [DistrictType.DISTRICT]: { km: 'ស្រុក', en: 'District' },
    [DistrictType.MUNICIPALITY]: { km: 'ក្រុង', en: 'Municipality' },
    [DistrictType.KHAN]: { km: 'ខណ្ឌ', en: 'Khan' },
  },
  commune: { [CommuneType.COMMUNE]: { km: 'ឃុំ', en: 'Commune' }, [CommuneType.SANGKAT]: { km: 'សង្កាត់', en: 'Sangkat' } },
  village: { km: 'ភូមិ', en: 'Village' },
} as const;

const fields = { code: true, khmerName: true, latinName: true } as const;

// A village with its commune, district and province, for formatting
export const villageWithParents = {
  select: {
    ...fields,
    commune: { select: { ...fields, type: true, district: { select: { ...fields, type: true, province: { select: { ...fields, type: true } } } } } },
  },
} as const satisfies { select: Prisma.VillageSelect };

type VillageWithParents = Prisma.VillageGetPayload<typeof villageWithParents>;

export interface FormattedAddress {
  village: { code: string; khmerName: string; latinName: string };
  commune: { code: string; type: CommuneType; khmerName: string; latinName: string };
  district: { code: string; type: DistrictType; khmerName: string; latinName: string };
  province: { code: string; type: ProvinceType; khmerName: string; latinName: string };
  khmer: string; // one line, as written in the registry
  latin: string;
}

/** Full address of a village, optionally after a house number and street (ផ្ទះលេខ … ផ្លូវ …) */
export function formatAddress(village: VillageWithParents, street?: { houseNo?: string | null; street?: string | null }): FormattedAddress {
  const { commune } = village;
  const { district } = commune;
  const { province } = district;
  const parts = [
    { km: LEVEL_PREFIX.village.km, en: LEVEL_PREFIX.village.en, unit: village },
    { ...LEVEL_PREFIX.commune[commune.type], unit: commune },
    { ...LEVEL_PREFIX.district[district.type], unit: district },
    { ...LEVEL_PREFIX.province[province.type], unit: province },
  ];
  const khmer = [
    street?.houseNo && `ផ្ទះលេខ${street.houseNo}`,
    street?.street && `ផ្លូវ${street.street}`,
    ...parts.map((p) => `${p.km}${p.unit.khmerName}`),
  ];
  const latin = [
    street?.houseNo && `No. ${street.houseNo}`,
    street?.street && `St. ${street.street}`,
    ...parts.map((p) => `${p.unit.latinName} ${p.en}`),
  ];
  const { district: _d, ...communeOnly } = commune;
  const { province: _p, ...districtOnly } = district;
  return {
    village: { code: village.code, khmerName: village.khmerName, latinName: village.latinName },
    commune: communeOnly,
    district: districtOnly,
    province,
    khmer: khmer.filter(Boolean).join(' '),
    latin: latin.filter(Boolean).join(', '),
  };
}

const byCode = { orderBy: { code: 'asc' } } as const;

export const listProvinces = () => prisma.province.findMany({ select: { ...fields, type: true }, ...byCode });

export async function listDistricts(provinceCode: string) {
  if (!(await prisma.province.findUnique({ where: { code: provinceCode } }))) throw Errors.LOCATION_NOT_FOUND('province', provinceCode);
  return prisma.district.findMany({ where: { provinceCode }, select: { ...fields, type: true }, ...byCode });
}

export async function listCommunes(districtCode: string) {
  if (!(await prisma.district.findUnique({ where: { code: districtCode } }))) throw Errors.LOCATION_NOT_FOUND('district', districtCode);
  return prisma.commune.findMany({ where: { districtCode }, select: { ...fields, type: true }, ...byCode });
}

export async function listVillages(communeCode: string) {
  if (!(await prisma.commune.findUnique({ where: { code: communeCode } }))) throw Errors.LOCATION_NOT_FOUND('commune', communeCode);
  return prisma.village.findMany({ where: { communeCode }, select: fields, ...byCode });
}

/** Villages whose Khmer or Latin name matches, with their full address (e.g. for a search-as-you-type field) */
export async function searchVillages(search: string, take: number) {
  const villages = await prisma.village.findMany({
    where: { OR: [{ khmerName: { contains: search } }, { latinName: { contains: search, mode: 'insensitive' } }] },
    ...villageWithParents,
    ...byCode,
    take,
  });
  return villages.map((v) => formatAddress(v));
}

export async function getVillage(code: string) {
  const village = await prisma.village.findUnique({ where: { code }, ...villageWithParents });
  if (!village) throw Errors.LOCATION_NOT_FOUND('village', code);
  return formatAddress(village);
}

/** Throws VILLAGE_NOT_FOUND for the first code (per request field) that isn't in the gazetteer */
export async function assertVillagesExist(codes: Record<string, string | undefined>) {
  const given = Object.entries(codes).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (!given.length) return;
  const found = new Set(
    (await prisma.village.findMany({ where: { code: { in: given.map(([, code]) => code) } }, select: { code: true } })).map((v) => v.code),
  );
  const missing = given.find(([, code]) => !found.has(code));
  if (missing) throw Errors.VILLAGE_NOT_FOUND(missing[0], missing[1]);
}
