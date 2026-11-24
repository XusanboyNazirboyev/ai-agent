import '@testing-library/jest-dom/vitest';

// Locales load lazily in the app; tests read every catalog synchronously.
import { LOCALES, loadCatalog } from '@/i18n';
await Promise.all(LOCALES.map((locale) => loadCatalog(locale)));
