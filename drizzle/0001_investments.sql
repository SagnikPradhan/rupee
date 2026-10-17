CREATE TYPE "public"."disposal_kind" AS ENUM('sale', 'transfer', 'gift', 'cover');--> statement-breakpoint
CREATE TYPE "public"."lot_origin" AS ENUM('buy', 'transfer', 'short', 'unpriced');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('line', 'posting');--> statement-breakpoint
CREATE TABLE "disposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"lot_id" uuid,
	"posting_id" uuid NOT NULL,
	"commodity" text NOT NULL,
	"kind" "disposal_kind" NOT NULL,
	"units" bigint NOT NULL,
	"price_amount" bigint,
	"price_commodity" text
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"posting_id" uuid NOT NULL,
	"source_id" uuid,
	"account" text NOT NULL,
	"commodity" text NOT NULL,
	"origin" "lot_origin" NOT NULL,
	"date" date NOT NULL,
	"units" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"cost_amount" bigint NOT NULL,
	"cost_commodity" text NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "postings" ADD COLUMN "cost_amount" bigint;--> statement-breakpoint
ALTER TABLE "postings" ADD COLUMN "cost_commodity" text;--> statement-breakpoint
ALTER TABLE "postings" ADD COLUMN "cost_date" date;--> statement-breakpoint
ALTER TABLE "disposals" ADD CONSTRAINT "disposals_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposals" ADD CONSTRAINT "disposals_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposals" ADD CONSTRAINT "disposals_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_source_id_lots_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_file_id_ledger_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ledger_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disposals_lot_id" ON "disposals" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "disposals_posting_id" ON "disposals" USING btree ("posting_id");--> statement-breakpoint
CREATE INDEX "disposals_ledger_id_commodity" ON "disposals" USING btree ("ledger_id","commodity");--> statement-breakpoint
CREATE INDEX "disposals_ledger_id_unmatched" ON "disposals" USING btree ("ledger_id") WHERE "disposals"."lot_id" IS NULL;--> statement-breakpoint
CREATE INDEX "lots_ledger_id_commodity_account" ON "lots" USING btree ("ledger_id","commodity","account");--> statement-breakpoint
CREATE INDEX "lots_posting_id" ON "lots" USING btree ("posting_id");--> statement-breakpoint
CREATE INDEX "lots_source_id" ON "lots" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "prices_file_id" ON "prices" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "prices_ledger_id_commodity_date" ON "prices" USING btree ("ledger_id","commodity","date");--> statement-breakpoint
CREATE INDEX "postings_ledger_id_commodity" ON "postings" USING btree ("ledger_id","commodity");--> statement-breakpoint
SELECT attach_updated_at();
