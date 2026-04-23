ALTER TABLE "subscriptions" ALTER COLUMN "credit_balance_cents" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "credit_balance_cents" SET DEFAULT '0';