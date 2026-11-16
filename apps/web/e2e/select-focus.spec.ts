import { expect, test } from '@playwright/test';

// Owner screenshot 2026-11-16: after opening and closing a select with the
// mouse, two blue rings stayed around it. A select draws no ring of its own,
// and its row draws one only for keyboard focus.
test('a select keeps no ring after a mouse pick, and shows one for the keyboard', async ({
  page,
}) => {
  await page.goto('/login');
  const select = page.getByLabel(/^(Language|Язык|Til)$/u).first();
  const outline = (): Promise<{ select: string; row: string }> =>
    select.evaluate((el) => ({
      select: getComputedStyle(el).outlineStyle,
      row: getComputedStyle(el.parentElement!).outlineStyle,
    }));

  await select.click();
  await page.keyboard.press('Escape');
  await expect.poll(outline).toEqual({ select: 'none', row: 'none' });

  // Leave, then come back with the keyboard: one ring, on the row.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(select).toBeFocused();
  await expect.poll(outline).toEqual({ select: 'none', row: 'solid' });
});
