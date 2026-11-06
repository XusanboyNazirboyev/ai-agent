/**
 * Instagram uses the shared Meta webhook authentication; the old names stay so
 * existing imports and tests keep working (see ../meta/meta-webhook-auth.ts).
 */
export {
  answerMetaHandshake as answerInstagramHandshake,
  signMetaBody as signInstagramBody,
  verifyMetaSignature as verifyInstagramSignature,
} from '../meta/meta-webhook-auth.js';
