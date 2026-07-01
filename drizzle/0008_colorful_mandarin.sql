CREATE TABLE "widget_chat_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"widget_user_id" uuid NOT NULL,
	"message_id" uuid,
	"server_id" text NOT NULL,
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
--> statement-breakpoint
ALTER TABLE "widget_chat_images" ADD CONSTRAINT "widget_chat_images_conversation_id_widget_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."widget_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_chat_images" ADD CONSTRAINT "widget_chat_images_widget_user_id_widget_users_id_fk" FOREIGN KEY ("widget_user_id") REFERENCES "public"."widget_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_chat_images" ADD CONSTRAINT "widget_chat_images_message_id_widget_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."widget_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_chat_images" ADD CONSTRAINT "widget_chat_images_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widget_chat_images_conversation_idx" ON "widget_chat_images" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "widget_chat_images_message_idx" ON "widget_chat_images" USING btree ("message_id");
