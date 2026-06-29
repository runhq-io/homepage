-- Server-owned refs for widget support-chat image uploads.
-- (The drizzle/ output is not applied by scripts/run-migration.js; this is.)
CREATE TABLE IF NOT EXISTS "widget_chat_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "widget_chat_conversations"("id") ON DELETE cascade,
  "widget_user_id" uuid NOT NULL REFERENCES "widget_users"("id") ON DELETE cascade,
  "message_id" uuid REFERENCES "widget_chat_messages"("id") ON DELETE cascade,
  "server_id" text NOT NULL REFERENCES "servers"("id"),
  "mime_type" text NOT NULL,
  "original_name" text,
  "original_storage_provider" text NOT NULL,
  "original_storage_key" text NOT NULL,
  "model_storage_provider" text NOT NULL,
  "model_storage_key" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "widget_chat_images_conversation_idx" ON "widget_chat_images" ("conversation_id");
CREATE INDEX IF NOT EXISTS "widget_chat_images_message_idx" ON "widget_chat_images" ("message_id");
