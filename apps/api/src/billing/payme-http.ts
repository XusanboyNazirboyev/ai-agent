import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import { PAYME_ERROR, paymeError } from './payme-rules.js';

const JSON_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * Parse this one route before Nest's global JSON parser. Payme requires
 * malformed JSON to be a JSON-RPC -32700 answer with HTTP 200; consuming the
 * body here also prevents the later parser from turning it into a generic 400.
 */
export function configurePaymeProtocol(app: NestExpressApplication): void {
  const parse: RequestHandler = (request, response, next) => {
    if (!request.is('application/json')) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > JSON_BODY_LIMIT_BYTES) tooLarge = true;
      else chunks.push(bytes);
    });
    request.on('error', next);
    request.on('end', () => {
      if (tooLarge) {
        response
          .status(413)
          .json({ statusCode: 413, message: 'Payload Too Large' });
        return;
      }
      const body = Buffer.concat(chunks);
      try {
        request.body = JSON.parse(body.toString('utf8')) as unknown;
        (request as typeof request & { rawBody?: Buffer }).rawBody = body;
        next();
      } catch {
        response.status(200).json({
          jsonrpc: '2.0',
          id: null,
          error: paymeError(PAYME_ERROR.PARSE),
        });
      }
    });
  };
  app.use('/api/v1/payments/payme', parse);
}
