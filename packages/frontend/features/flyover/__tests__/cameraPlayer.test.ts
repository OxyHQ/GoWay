/** Skip back/forward between chapters (and the reduced-motion stills). */
import { describe, expect, test } from 'bun:test';

import { nextChapter } from '@/features/flyover/useCameraPlayer';

const CHAPTERS = [0, 3000, 9000, 15000, 20000];

describe('nextChapter', () => {
  test('forward goes to the next chapter, and stops at the end', () => {
    expect(nextChapter(CHAPTERS, 0, 1)).toBe(3000);
    expect(nextChapter(CHAPTERS, 3000, 1)).toBe(9000);
    expect(nextChapter(CHAPTERS, 10000, 1)).toBe(15000);
    expect(nextChapter(CHAPTERS, 20000, 1)).toBe(20000);
  });

  test('back goes to the previous chapter, or the one before when just past one', () => {
    expect(nextChapter(CHAPTERS, 12000, -1)).toBe(9000);
    expect(nextChapter(CHAPTERS, 9300, -1)).toBe(3000);
    expect(nextChapter(CHAPTERS, 500, -1)).toBe(0);
    expect(nextChapter([], 500, -1)).toBe(0);
  });
});
