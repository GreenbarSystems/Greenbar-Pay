CREATE TYPE "public"."contract_status" AS ENUM('pending_extraction', 'extracted', 'active', 'superseded', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('invoice', 'contract');--> statement-breakpoint
CREATE TABLE "vendor_contract_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"description" text NOT NULL,
	"item_keyword" text,
	"unit_price" numeric(12, 4),
	"currency" text,
	"price_basis" text,
	"min_quantity" numeric(12, 4),
	"max_quantity" numeric(12, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid,
	"document_id" uuid NOT NULL,
	"llm_run_id" uuid,
	"contract_number" text,
	"effective_date" date,
	"expiry_date" date,
	"payment_terms" text,
	"early_payment_discount_pct" numeric(5, 2),
	"early_payment_discount_days" integer,
	"currency" text,
	"status" "contract_status" DEFAULT 'pending_extraction' NOT NULL,
	"confidence" text,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" "document_kind" DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_contract_lines" ADD CONSTRAINT "vendor_contract_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contract_lines" ADD CONSTRAINT "vendor_contract_lines_contract_id_vendor_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_llm_run_id_llm_runs_id_fk" FOREIGN KEY ("llm_run_id") REFERENCES "public"."llm_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vendor_contract_lines_contract" ON "vendor_contract_lines" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_contract_lines_org_keyword" ON "vendor_contract_lines" USING btree ("organization_id","item_keyword");--> statement-breakpoint
CREATE INDEX "idx_vendor_contracts_org_vendor" ON "vendor_contracts" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_contracts_org_status" ON "vendor_contracts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_vendor_contracts_document" ON "vendor_contracts" USING btree ("document_id");