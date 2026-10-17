CREATE TYPE "public"."price_source" AS ENUM('line', 'posting');--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"line" integer NOT NULL,
	"date" date NOT NULL,
	"commodity" text NOT NULL,
	"price_amount" bigint NOT NULL,
	"price_commodity" text NOT NULL,
	"source" "price_source" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_file_id_ledger_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ledger_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prices_file_id" ON "prices" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "prices_ledger_id_commodity_date" ON "prices" USING btree ("ledger_id","commodity","date");--> statement-breakpoint
SELECT attach_updated_at();
