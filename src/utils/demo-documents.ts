// Placeholder documents for demo students: a 4x4 "photo" (coloured background, silhouette and initials) and a
// birth certificate scan clearly marked as not real. Only for demo data (see seed-students --demo-placeholders).
import sharp from 'sharp';
import { Gender } from '../generated/prisma/client';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function hue(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export async function demoPhoto(student: { latinName: string; gender: Gender }) {
  const initials = student.latinName
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const background = `hsl(${hue(student.latinName)}, 45%, ${student.gender === Gender.F ? 80 : 72}%)`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="600" height="600" fill="${background}"/>
    <circle cx="300" cy="230" r="120" fill="#ffffff" fill-opacity="0.85"/>
    <path d="M90 600 C 110 400, 490 400, 510 600 Z" fill="#ffffff" fill-opacity="0.85"/>
    <text x="300" y="268" font-family="Arial, Helvetica, sans-serif" font-size="110" font-weight="bold" text-anchor="middle" fill="#555">${escape(initials)}</text>
    <text x="300" y="585" font-family="Arial, Helvetica, sans-serif" font-size="28" text-anchor="middle" fill="#999">DEMO</text>
  </svg>`;
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), originalName: 'demo-photo.png' };
}

export async function demoBirthCertificate(student: { birthCertificateNo: string; latinName: string; dateOfBirth: Date; gender: Gender }) {
  const lines = [
    `Certificate No.  ${student.birthCertificateNo}`,
    `Name  ${student.latinName}`,
    `Date of birth  ${student.dateOfBirth.toISOString().slice(0, 10)}`,
    `Sex  ${student.gender === Gender.F ? 'Female' : 'Male'}`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="874">
    <rect width="1240" height="874" fill="#fbf8ee"/>
    <rect x="30" y="30" width="1180" height="814" fill="none" stroke="#8a7a50" stroke-width="6"/>
    <text x="620" y="140" font-family="Arial, Helvetica, sans-serif" font-size="56" font-weight="bold" text-anchor="middle" fill="#5a4a20">BIRTH CERTIFICATE</text>
    ${lines.map((l, i) => `<text x="140" y="${290 + i * 90}" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="#333">${escape(l)}</text>`).join('\n    ')}
    <text x="620" y="790" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="bold" text-anchor="middle" fill="#c0392b">DEMO DATA — NOT A REAL DOCUMENT</text>
  </svg>`;
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), originalName: 'demo-birth-certificate.png' };
}
