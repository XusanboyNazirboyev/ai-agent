-- ADR 042: customer voice notes (additive).
ALTER TYPE "MessageType" ADD VALUE 'VOICE';

CREATE TYPE "VoiceStatus" AS ENUM ('PENDING', 'TRANSCRIBED', 'FAILED');

ALTER TABLE "messages"
    ADD COLUMN "voice_status" "VoiceStatus",
    ADD COLUMN "media_ref" VARCHAR(2048),
    ADD COLUMN "media_mime_type" VARCHAR(100),
    ADD COLUMN "media_duration_seconds" INTEGER;
