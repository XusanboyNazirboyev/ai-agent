import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Owner report 2026-11-16: opening "Invite" with the mouse and cancelling left
// a blue ring around the settings area. After a mouse press, focus the browser
// gives back draws no ring; the keyboard still gets one.
test('no ring after cancelling a dialog with the mouse; a ring with the keyboard', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  try {
    await page.goto('/settings/team');
    const ring = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return 'none';
        // A select draws its ring on its row (ui/select.tsx).
        const target = el.classList.contains('tz-select')
          ? el.parentElement!
          : el;
        return getComputedStyle(target).outlineStyle;
      });
    // Click the empty area first (the scroll region takes focus), then invite.
    await page
      .getByRole('region')
      .first()
      .click({ position: { x: 5, y: 5 } });
    await page.getByTestId('team-invite').click();
    const dialog = page.getByTestId('team-invite-dialog');
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('button', { name: /^(Cancel|Отмена|Bekor qilish)$/u })
      .click();
    await expect(dialog).toBeHidden();
    await expect.poll(ring).toBe('none');

    // Keyboard use shows the ring again.
    await page.keyboard.press('Tab');
    await expect.poll(ring).toBe('solid');
  } finally {
    await context.close();
  }
});
