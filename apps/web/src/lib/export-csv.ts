import { ApiError } from './api';

function filenameFromDisposition(
  value: string | null,
  fallback: string,
): string {
  if (!value) return fallback;
  const m = /filename="?([^";]+)"?/i.exec(value);
  return m?.[1] ?? fallback;
}

export async function downloadCsv(
  path: string,
  fallbackName: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'text/csv' },
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const body =
      parsed && typeof parsed === 'object'
        ? (parsed as { code?: unknown; i18nKey?: unknown })
        : {};
    throw new ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'UNKNOWN',
      typeof body.i18nKey === 'string' ? body.i18nKey : undefined,
    );
  }
  const blob = await response.blob();
  const name = filenameFromDisposition(
    response.headers.get('content-disposition'),
    fallbackName,
  );
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked later: some browsers start the save after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return name;
}
