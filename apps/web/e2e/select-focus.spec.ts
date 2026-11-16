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

test('a click on the chevron or the icon lands on the select itself (owner report 2026-11-16)', async ({
  page,
}) => {
  await page.goto('/login');
  const select = page.getByLabel(/^(Language|Язык|Til)$/u).first();
  // Whatever element sits under the centre of the icon and the chevron is
  // what a click hits: it must be the native select, so every browser opens
  // its own picker (showPicker() did not in all of them).
  const hits = await select.evaluate((el) => {
    const svgs = Array.from(el.parentElement!.querySelectorAll('svg'));
    return svgs.map((svg) => {
      const box = svg.getBoundingClientRect();
      return (
        document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        ) === el
      );
    });
  });
  expect(hits).toEqual([true, true]);
  const chevron = select.locator('xpath=following-sibling::*[1]');
  const box = (await chevron.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(select).toBeFocused();
  // Opened with the mouse: no keyboard ring on the row.
  await expect
    .poll(() =>
      select.evaluate((el) => getComputedStyle(el.parentElement!).outlineStyle),
    )
    .toBe('none');
  await page.keyboard.press('Escape');
  await expect(select).toBeFocused();
});
