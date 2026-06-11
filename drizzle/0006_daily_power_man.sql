ALTER TABLE "users" ADD COLUMN "totp_secret" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp;