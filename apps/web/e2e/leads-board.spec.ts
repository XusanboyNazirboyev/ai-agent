import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Lead funnel (ADR 058, UX standard): the board is for scanning and moving, the
// side panel is for editing; the stage is the only thing an operator sets.

async function resetLead(
  page: Page,
  conversationId: string,
  newStageId: string | null,
): Promise<void> {
  // Restores the shared fixture lead: the stage it started in.
  await page.evaluate(
    async ({ id, stageId }) => {
      const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
      const call = (
        method: string,
        path: string,
        body: unknown,
      ): Promise<Response> =>
        fetch(path, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': decodeURIComponent(csrf),
          },
          body: JSON.stringify(body),
        });
      if (stageId) {
        const listed = (await (
          await fetch('/api/v1/leads?limit=50')
        ).json()) as {
          items: { id: string; conversation: { id: string } }[];
        };
        const lead = listed.items.find((item) => item.conversation.id === id);
        if (lead)
          await call('PATCH', `/api/v1/leads/${lead.id}/stage`, { stageId });
      }
    },
    { id: conversationId, stageId: newStageId },
  );
}

/** The stage a conversation's lead sits in now (null = first column). */
async function stageOf(
  page: Page,
  conversationId: string,
): Promise<string | null> {
  return page.evaluate(async (id) => {
    const listed = (await (await fetch('/api/v1/leads?limit=50')).json()) as {
      items: {
        pipelineStageId: string | null;
        pipelineId: string;
        conversation: { id: string };
      }[];
    };
    const lead = listed.items.find((item) => item.conversation.id === id);
    if (!lead) return null;
    if (lead.pipelineStageId) return lead.pipelineStageId;
    const board = (await (
      await fetch(`/api/v1/pipelines/${lead.pipelineId}/board`)
    ).json()) as { stages: { id: string }[] };
    return board.stages[0]?.id ?? null;
  }, conversationId);
}

/** One lead card, found by the customer's name. */
const cardOf = (page: Page, name: string): Locator =>
  page.getByTestId('lead-card').filter({ hasText: name });

test('an operator moves a lead with the panel progress bar', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  let originalStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    originalStageId = await stageOf(page, conversationId);
    const card = cardOf(page, contactName);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('lead-card-channel')).toHaveText('Telegram');

    // The card is compact: no stage select, score, status or action buttons.
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(card.getByTestId('lead-card-score')).toHaveCount(0);
    await expect(card.getByTestId('lead-card-status')).toHaveCount(0);
    await expect(card.getByTestId('lead-accept-suggestion')).toHaveCount(0);

    // Open the panel with the mouse on the empty card area, close it, then
    // open it again from the name button.
    const panel = page.getByTestId('lead-panel');
    await card.click({ position: { x: 4, y: 4 } });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(card.getByTestId('lead-card-open')).toBeFocused();
    await card.getByTestId('lead-card-open').click();
    await expect(
      panel.getByRole('heading', { name: contactName }),
    ).toBeVisible();

    // Click a different open step.
    const steps = panel.getByTestId('lead-panel-stages').getByRole('button');
    const ids = await steps.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid') ?? ''),
    );
    const current = await panel
      .locator('[aria-current="step"]')
      .getAttribute('data-testid');
    const target = ids.find(
      (id) => id !== current && !/-(WON|LOST)$/u.test(id),
    )!;
    const code = target.replace('lead-panel-stage-', '');
    await panel.getByTestId(target).click();
    await expect(panel.getByTestId(target)).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(
      page.getByTestId(`lead-column-${code}`).getByTestId('lead-card').filter({
        hasText: contactName,
      }),
    ).toHaveCount(1);
  } finally {
    await resetLead(page, conversationId, originalStageId);
    await context.close();
  }
});

test('marking a lead lost asks for a reason first', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  let originalStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    originalStageId = await stageOf(page, conversationId);
    await cardOf(page, contactName).getByTestId('lead-card-open').click();
    const panel = page.getByTestId('lead-panel');
    await panel.getByTestId('lead-panel-stage-LOST').click();
    const dialog = page.getByTestId('lead-lost-dialog');
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel(/lost reason|Причина|sababi/i)
      .fill('Too expensive');
    await dialog
      .getByRole('button', { name: /save|Сохранить|Saqlash/i })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId('lead-column-LOST').getByTestId('lead-card').filter({
        hasText: contactName,
      }),
    ).toHaveCount(1);
    await expect(panel.getByTestId('lead-panel-lost-reason')).toContainText(
      'Too expensive',
    );
    // Closed columns show no age chip.
    await expect(
      page
        .getByTestId('lead-column-LOST')
        .getByTestId('lead-card')
        .filter({ hasText: contactName })
        .getByTestId('lead-card-age'),
    ).toHaveCount(0);
  } finally {
    await resetLead(page, conversationId, originalStageId);
    await context.close();
  }
});

test('the list view and the filters share the same panel', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { contactName } = f.a.conversations[0]!;
  await page.goto('/leads?view=funnel');
  await expect(cardOf(page, contactName)).toBeVisible();
  await page
    .getByTestId('leads-view-toggle')
    .getByRole('button')
    .last()
    .click();
  const row = page
    .getByTestId('lead-list-row')
    .filter({ hasText: contactName });
  await expect(row).toBeVisible();
  await row.getByTestId('lead-list-open').click();
  await expect(
    page.getByTestId('lead-panel').getByRole('heading', { name: contactName }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // A filter with no match empties the list; its chip removes it.
  await page.getByTestId('leads-filters-button').click();
  await page.getByLabel(/^(source|Источник|Manba)$/i).fill('no-such-source');
  await expect(page.getByTestId('lead-list-row')).toHaveCount(0);
  await expect(page.getByTestId('leads-filters-count')).toBeVisible();
  await page.getByTestId('leads-filter-chip-source').click();
  await expect(row).toBeVisible();
  await context.close();
});

test('a viewer sees the funnel and the panel but cannot change a lead', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page.goto('/leads?view=funnel');
  const card = cardOf(page, f.a.conversations[0]!.contactName);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('lead-card-handle')).toHaveCount(0);
  await card.getByTestId('lead-card-open').click();
  const panel = page.getByTestId('lead-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('lead-panel-ai')).toHaveCount(0);
  const steps = panel.getByTestId('lead-panel-stages').getByRole('button');
  for (const step of await steps.all()) await expect(step).toBeDisabled();
  await context.close();
});

test('a lead card is dragged to another column with the mouse', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  let originalStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    originalStageId = await stageOf(page, conversationId);
    const card = cardOf(page, contactName);
    await expect(card).toBeVisible();
    // No stage name anywhere on the card.
    await expect(card).not.toContainText(
      /contacted|qualified|proposal|won|lost/i,
    );
    const target = page.getByTestId('lead-column-CONTACTED');
    const from = (await card.getByTestId('lead-card-handle').boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 20, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 8 });
    await expect(target).toHaveClass(/ring-primary/);
    await page.mouse.up();
    await expect(
      target.getByTestId('lead-card').filter({ hasText: contactName }),
    ).toHaveCount(1);
    await expect(page.getByTestId('lead-panel')).toBeHidden();
  } finally {
    await resetLead(page, conversationId, originalStageId);
    await context.close();
  }
});

test('on a phone a lead card is swiped to the next stage', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 375, height: 800 },
    hasTouch: true,
  });
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  let originalStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    originalStageId = await stageOf(page, conversationId);
    const tabs = page.getByTestId('leads-stage-tabs');
    await expect(tabs).toBeVisible();
    await tabs.getByTestId('leads-stage-tab').first().click();
    const card = cardOf(page, contactName);
    await expect(card).toBeVisible();
    // A short drag snaps back and keeps the card where it is.
    const swipe = (dx: number): Promise<void> =>
      card.evaluate((el, distance) => {
        const fire = (type: string, x: number): void => {
          const event = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: 300,
          });
          const target =
            type === 'pointerdown'
              ? (el.querySelector('[data-testid="lead-card-handle"]') ?? el)
              : el;
          target.dispatchEvent(event);
        };
        fire('pointerdown', 100);
        fire('pointermove', 100 + distance / 2);
        fire('pointermove', 100 + distance);
        fire('pointerup', 100 + distance);
      }, dx);
    await swipe(20);
    await expect(card).toBeVisible();
    // A long swipe to the right moves it to the next stage.
    await swipe(250);
    await expect(page.getByTestId('leads-live')).toHaveText(/Moved to/);
    await expect(
      page.getByTestId('lead-column-NEW').getByTestId('lead-card'),
    ).toHaveCount(0);
    await tabs.getByRole('button', { name: /Contacted/ }).click();
    await expect(
      page
        .getByTestId('lead-column-CONTACTED')
        .getByTestId('lead-card')
        .filter({ hasText: contactName }),
    ).toHaveCount(1);
  } finally {
    await resetLead(page, conversationId, originalStageId);
    await context.close();
  }
});
