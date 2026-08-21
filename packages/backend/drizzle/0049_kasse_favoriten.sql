CREATE TABLE "kasse_favoriten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"artikel_id" uuid
);--> statement-breakpoint
ALTER TABLE "kasse_favoriten" ADD CONSTRAINT "kasse_favoriten_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kasse_favoriten" ADD CONSTRAINT "kasse_favoriten_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "kassen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kasse_favoriten" ADD CONSTRAINT "kasse_favoriten_artikel_id_artikel_id_fk" FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kasse_favoriten_kasse_idx" ON "kasse_favoriten" ("kasse_id");--> statement-breakpoint
ALTER TABLE "kassen" ADD COLUMN "artikel_pro_zeile" integer DEFAULT 4 NOT NULL;
