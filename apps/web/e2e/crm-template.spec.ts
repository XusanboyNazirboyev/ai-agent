import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// The ready tourism template on the Sales stages page (step 7). The e2e
// workspaces are education ones, so the template is faked here; its API is
// covered by the integration tests.

const VIEW = {
  available: true,
  key: 'tourism',
  pipelineName: 'Tours',
  pipelineExists: false,
  stages: [
    { code: 'INQUIRY', kind: 'OPEN' },
    { code: 'OFFER_SENT', kind: 'OPEN' },
    { code: 'PREPAYMENT', kind: 'OPEN' },
    { code: 'DOCUMENTS', kind: 'OPEN' },
    { code: 'PAID', kind: 'WON' },
    { code: 'TRAVELLED', kind: 'WON' },
    { code: 'LOST', kind: 'LOST' },
  ],
  leadFields: [
    { key: 'destination', type: 'TEXT', label: 'Destination', exists: false },
    { key: 'budget', type: 'NUMBER', label: 'Budget per person', exists: true },
  ],
  tags: [
    { name: 'Family', color: 'green', exists: false },
    { name: 'Hot tour', color: 'red', exists: false },
  ],
};

async function fake(
  page: Page,
  onApply: (body: unknown) => void,
): Promise<void> {
  let applied = false;
  await page.route('**/api/v1/crm-template', (route) =>
    route.fulfill({ json: { ...VIEW, pipelineExists: applied } }),
  );
  await page.route('**/api/v1/crm-template/apply', (route) => {
    onApply(route.request().postDataJSON());
    applied = true;
    return route.fulfill({
      json: {
        pipelineId: 'p',
        created: { pipeline: true, fields: 1, tags: 2 },
        madeDefault: true,
      },
    });
  });
}

test('an admin sees the template, what it adds, and applies it once', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  const bodies: unknown[] = [];
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await fake(page, (body) => bodies.push(body));
    await page.goto('/settings/pipeline');
    const card = page.getByTestId('crm-template');
    await expect(card).toContainText('Ready template: Tours');
    // Stage codes read as words in the viewer's language.
    await expect(page.getByTestId('crm-template-stages')).toContainText(
      'Inquiry',
    );
    await expect(page.getByTestId('crm-template-stages')).toContainText(
      'Documents and visa',
    );
    await expect(page.getByTestId('crm-template-stages')).not.toContainText(
      'OFFER_SENT',
    );
    // Only what is missing is listed: the existing budget field is not.
    await expect(card).toContainText('Destination');
    await expect(card).not.toContainText('Budget per person');
    await expect(card).toContainText('Hot tour');
    await expect(card).toContainText('Nothing you already have is changed');

    await page.getByTestId('crm-template-default').uncheck();
    await page.getByTestId('crm-template-default').check();
    await page.getByTestId('crm-template-apply').click();
    await expect(card).toHaveCount(0);
    expect(bodies).toEqual([{ makeDefault: true }]);
  } finally {
    await context.close();
  }
});

test('a workspace without a template sees no card, and an operator never asks for it', async ({
  browser,
}) => {
  const f = fixtures();
  const admin = await newSession(browser, f.a.operators.admin.email);
  const operator = await newSession(browser, f.a.operators.op1.email);
  try {
    await admin.page.goto('/settings/pipeline');
    await expect(admin.page.getByTestId('pipeline-create')).toBeVisible();
    await expect(admin.page.getByTestId('crm-template')).toHaveCount(0);

    let asked = 0;
    operator.page.on('request', (request) => {
      if (request.url().includes('/api/v1/crm-template')) asked += 1;
    });
    await operator.page.goto('/settings/pipeline');
    await expect(
      operator.page.getByText(/read only|only an owner/iu).first(),
    ).toBeVisible();
    await expect(operator.page.getByTestId('crm-template')).toHaveCount(0);
    expect(asked).toBe(0);
  } finally {
    await admin.context.close();
    await operator.context.close();
  }
});

test('the card has no accessibility violations and fits a phone in en, ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 1280],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      {
        viewport: { width, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await fake(page, () => undefined);
      await page.goto('/settings/pipeline');
      await expect(page.getByTestId('crm-template')).toBeVisible();
      expect(
        await findOverflow(page),
        `overflow ${language} ${width}px`,
      ).toEqual([]);
      const result = await new AxeBuilder({ page })
        .include('[data-testid="crm-template"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`,
        ),
        `axe ${language}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
