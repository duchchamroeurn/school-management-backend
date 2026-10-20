import { describe, expect, it } from 'vitest';
import { mentionFor } from '../../src/constants/grading';
import { khmerDate, khmerDigits, khmerScore } from '../../src/constants/khmer';
import { assertConfigComponentsValid } from '../../src/utils/assessment';

// 'OK', or the error code the rule raised
const code = (fn: () => void) => {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code: string }).code;
  }
};
const components = (...max: number[]) => max.map((maxScore, i) => ({ name: `C${i}`, maxScore }));

describe('assertConfigComponentsValid', () => {
  it('accepts a directly scored subject and components that add up exactly', () => {
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 50, isComponentBased: false, components: [] }))).toBe('OK');
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 100, isComponentBased: true, components: components(20, 30, 50) }))).toBe('OK');
  });

  it('compares decimals exactly, without floating-point noise', () => {
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 0.3, isComponentBased: true, components: components(0.1, 0.2) }))).toBe('OK');
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 50, isComponentBased: true, components: components(12.5, 37.5) }))).toBe('OK');
  });

  it('rejects components that add up to more or less than the maximum', () => {
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 100, isComponentBased: true, components: components(20, 30) }))).toBe('COMPONENT_TOTAL_MISMATCH');
    expect(code(() => assertConfigComponentsValid({ maxTotalScore: 100, isComponentBased: true, components: components(60, 50) }))).toBe('COMPONENT_TOTAL_MISMATCH');
  });

  it('rejects inconsistent rule shapes', () => {
    const errorOf = (rule: Parameters<typeof assertConfigComponentsValid>[0]) => {
      try {
        assertConfigComponentsValid(rule);
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(errorOf({ maxTotalScore: 100, isComponentBased: true, components: [] })).toMatch(/at least one component/);
    expect(errorOf({ maxTotalScore: 100, isComponentBased: false, components: components(100) })).toMatch(/not component-based/);
    expect(errorOf({ maxTotalScore: 0, isComponentBased: false, components: [] })).toMatch(/greater than 0/);
    expect(errorOf({ maxTotalScore: 100, isComponentBased: true, components: [{ name: 'Exam', maxScore: 50 }, { name: 'exam ', maxScore: 50 }] })).toMatch(/more than once/);
  });
});

describe('mentionFor (MoEYS A–F on the average %)', () => {
  it.each([
    [100, 'A'], [90, 'A'], [89.99, 'B'], [80, 'B'], [79.99, 'C'], [70, 'C'],
    [60, 'D'], [59.99, 'E'], [50, 'E'], [49.99, 'F'], [0, 'F'],
  ])('%s%% → %s', (average, mention) => {
    expect(mentionFor(average)).toBe(mention);
  });
});

describe('Khmer formatting', () => {
  it('writes digits, scores and dates in Khmer', () => {
    expect(khmerDigits('2026-2027')).toBe('២០២៦-២០២៧');
    expect(khmerScore(12.5)).toBe('១២.៥');
    expect(khmerScore(48)).toBe('៤៨');
    expect(khmerDate(new Date('2014-08-07T00:00:00Z'))).toBe('៧ សីហា ២០១៤');
  });
});
