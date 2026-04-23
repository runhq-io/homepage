ALTER TABLE "usage_adjustments" DROP CONSTRAINT "usage_adjustments_admin_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_adjustments" ALTER COLUMN "admin_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;