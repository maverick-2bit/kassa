ALTER TABLE "kassen" ADD COLUMN "kellner_tischwahl" varchar(20) DEFAULT 'manuell' NOT NULL;--> statement-breakpoint
ALTER TABLE "kassen" ADD COLUMN "kellner_favoriten_aktiv" boolean DEFAULT false NOT NULL;
