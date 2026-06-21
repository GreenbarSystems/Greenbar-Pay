CREATE TYPE "public"."document_source" AS ENUM('upload', 'email', 'api');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('received', 'processing', 'text_extracted', 'llm_extracted', 'validation_failed', 'review_required', 'approved', 'rejected', 'exported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_attachment_status" AS ENUM('received', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."email_message_status" AS ENUM('received', 'processing', 'processed', 'no_attachments', 'unrouted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."export_format" AS ENUM('csv', 'json');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('created', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_review_status" AS ENUM('pending', 'needs_review', 'approved', 'rejected', 'exported', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."llm_run_status" AS ENUM('started', 'succeeded', 'schema_failed', 'provider_error', 'text_too_large', 'quota_exceeded', 'circuit_open');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'reviewer', 'clerk', 'viewer');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"external_accounting_system" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_client_access" (
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	CONSTRAINT "user_client_access_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'reviewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"email_message_id" uuid,
	"email_attachment_id" uuid,
	"source" "document_source" NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text,
	"storage_key" text NOT NULL,
	"content_hash" text,
	"page_count" integer,
	"status" "document_status" DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"method" text NOT NULL,
	"provider" text,
	"raw_text_storage_key" text NOT NULL,
	"text_length" integer DEFAULT 0 NOT NULL,
	"quality_score" numeric(5, 4),
	"average_confidence" numeric(5, 4),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_name" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text,
	"input_tokens_estimate" integer,
	"output_json" jsonb,
	"status" "llm_run_status" NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"line_number" integer,
	"description" text,
	"quantity" numeric(14, 4),
	"unit_price" numeric(14, 4),
	"amount" numeric(14, 2),
	"confidence_score" text,
	"confidence_reason" text,
	"hist_sample_count" integer,
	"hist_avg_price" numeric(14, 4),
	"hist_stddev_price" numeric(14, 4),
	"stddev_distance" numeric(7, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extracted_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"document_id" uuid NOT NULL,
	"llm_run_id" uuid,
	"document_type" text DEFAULT 'invoice' NOT NULL,
	"vendor_name" text,
	"vendor_address" text,
	"remit_to_name" text,
	"remit_to_address" text,
	"invoice_number" text,
	"invoice_date" date,
	"due_date" date,
	"payment_terms" text,
	"purchase_order_number" text,
	"currency" text DEFAULT 'USD',
	"subtotal" numeric(14, 2),
	"tax" numeric(14, 2),
	"shipping" numeric(14, 2),
	"discount" numeric(14, 2),
	"total" numeric(14, 2),
	"confidence" text,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" "invoice_review_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefing_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"llm_run_id" uuid,
	"gl_code" text,
	"gl_rationale" text NOT NULL,
	"anomaly_flags_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delta_summary" text DEFAULT '' NOT NULL,
	"risk_score" integer NOT NULL,
	"risk_justification" text NOT NULL,
	"risk_score_version" text DEFAULT 'pr6-baseline' NOT NULL,
	"vendor_context_json" jsonb,
	"risk_factors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coaching_prompts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vendor_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"vendor_id" uuid,
	"match_confidence" text NOT NULL,
	"match_score" numeric(5, 4),
	"match_method" text,
	"candidates_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_pricing_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"item_keyword" text NOT NULL,
	"avg_unit_price" numeric(16, 4) NOT NULL,
	"samples" integer NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"stddev_unit_price" numeric(14, 4),
	"min_unit_price" numeric(14, 4),
	"max_unit_price" numeric(14, 4),
	"last_unit_price" numeric(14, 4),
	"price_trend" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_payment_terms" text,
	"default_gl_code" text,
	"external_vendor_id" text,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"last_invoice_date" date,
	"spend_30d" numeric(16, 2) DEFAULT '0' NOT NULL,
	"spend_90d" numeric(16, 2) DEFAULT '0' NOT NULL,
	"avg_invoice_amount" numeric(16, 2) DEFAULT '0' NOT NULL,
	"duplicate_submission_count" integer DEFAULT 0 NOT NULL,
	"terms_drift_detected" boolean DEFAULT false NOT NULL,
	"last_profile_updated" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"passed" boolean NOT NULL,
	"severity" text NOT NULL,
	"errors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "export_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"status" text DEFAULT 'included' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"format" "export_format" NOT NULL,
	"storage_key" text,
	"file_size_bytes" integer,
	"item_count" integer DEFAULT 0 NOT NULL,
	"status" "export_status" DEFAULT 'created' NOT NULL,
	"error_message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"client_id" uuid,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"raw_message_storage_key" text NOT NULL,
	"routing_address" text NOT NULL,
	"mailbox" text NOT NULL,
	"from_email" text,
	"from_name" text,
	"subject" text,
	"body_text" text,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "email_message_status" DEFAULT 'received' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"email_message_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"sniffed_mime_type" text,
	"storage_key" text NOT NULL,
	"file_size_bytes" bigint,
	"content_hash" text,
	"status" "email_attachment_status" DEFAULT 'received' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_organization_id_key_pk" PRIMARY KEY("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "evidence_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_by_user_id" uuid,
	"manifest_hash" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"source_document_hash" text NOT NULL,
	"pdf_storage_key" text,
	"pdf_generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_override_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extracted_invoice_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"overriding_user_id" uuid NOT NULL,
	"second_approver_id" uuid,
	"justification_text" text NOT NULL,
	"override_amount" numeric(14, 2),
	"blocking_finding_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_client_access" ADD CONSTRAINT "user_client_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_client_access" ADD CONSTRAINT "user_client_access_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_email_attachment_id_email_attachments_id_fk" FOREIGN KEY ("email_attachment_id") REFERENCES "public"."email_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD CONSTRAINT "llm_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD CONSTRAINT "llm_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoice_lines" ADD CONSTRAINT "extracted_invoice_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoice_lines" ADD CONSTRAINT "extracted_invoice_lines_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoices" ADD CONSTRAINT "extracted_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoices" ADD CONSTRAINT "extracted_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoices" ADD CONSTRAINT "extracted_invoices_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoices" ADD CONSTRAINT "extracted_invoices_llm_run_id_llm_runs_id_fk" FOREIGN KEY ("llm_run_id") REFERENCES "public"."llm_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_invoices" ADD CONSTRAINT "extracted_invoices_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_cards" ADD CONSTRAINT "briefing_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_cards" ADD CONSTRAINT "briefing_cards_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_cards" ADD CONSTRAINT "briefing_cards_llm_run_id_llm_runs_id_fk" FOREIGN KEY ("llm_run_id") REFERENCES "public"."llm_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_matches" ADD CONSTRAINT "vendor_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_matches" ADD CONSTRAINT "vendor_matches_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_matches" ADD CONSTRAINT "vendor_matches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_pricing_history" ADD CONSTRAINT "vendor_pricing_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_pricing_history" ADD CONSTRAINT "vendor_pricing_history_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_results" ADD CONSTRAINT "validation_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_export_id_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_sealed_by_user_id_users_id_fk" FOREIGN KEY ("sealed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_override_log" ADD CONSTRAINT "invoice_override_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_override_log" ADD CONSTRAINT "invoice_override_log_extracted_invoice_id_extracted_invoices_id_fk" FOREIGN KEY ("extracted_invoice_id") REFERENCES "public"."extracted_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_override_log" ADD CONSTRAINT "invoice_override_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_override_log" ADD CONSTRAINT "invoice_override_log_overriding_user_id_users_id_fk" FOREIGN KEY ("overriding_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_override_log" ADD CONSTRAINT "invoice_override_log_second_approver_id_users_id_fk" FOREIGN KEY ("second_approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_content_hash_uniq" ON "documents" USING btree ("organization_id","content_hash");--> statement-breakpoint
CREATE INDEX "idx_documents_org_status" ON "documents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_documents_client_status" ON "documents" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "idx_documents_content_hash" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_documents_org_received" ON "documents" USING btree ("organization_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_document_extractions_doc_latest" ON "document_extractions" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_runs_doc_latest" ON "llm_runs" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_runs_org_created" ON "llm_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_extracted_invoice_lines_parent" ON "extracted_invoice_lines" USING btree ("extracted_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_extracted_invoices_org_review_status" ON "extracted_invoices" USING btree ("organization_id","review_status");--> statement-breakpoint
CREATE INDEX "idx_extracted_invoices_vendor_invoice" ON "extracted_invoices" USING btree ("organization_id","vendor_name","invoice_number");--> statement-breakpoint
CREATE INDEX "idx_extracted_invoices_document_id" ON "extracted_invoices" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_briefing_cards_invoice_active" ON "briefing_cards" USING btree ("extracted_invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_vendor_matches_invoice" ON "vendor_matches" USING btree ("extracted_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_pricing_vendor" ON "vendor_pricing_history" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vendors_org_normalized" ON "vendors" USING btree ("organization_id","normalized_name");--> statement-breakpoint
CREATE INDEX "idx_vendors_org" ON "vendors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_vendors_org_count_lastinv" ON "vendors" USING btree ("organization_id","invoice_count" DESC NULLS LAST,"last_invoice_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_validation_results_entity" ON "validation_results" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_export_items_export" ON "export_items" USING btree ("export_id");--> statement-breakpoint
CREATE INDEX "idx_exports_org_created" ON "exports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_email_messages_provider_message" ON "email_messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "idx_email_messages_mailbox_received" ON "email_messages" USING btree ("mailbox","received_at");--> statement-breakpoint
CREATE INDEX "idx_email_messages_org_received" ON "email_messages" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_email_attachments_message" ON "email_attachments" USING btree ("email_message_id");--> statement-breakpoint
CREATE INDEX "idx_audit_events_entity" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_events_entity_seq" ON "audit_events" USING btree ("entity_type","entity_id","created_at","seq");--> statement-breakpoint
CREATE INDEX "idx_api_idempotency_keys_created" ON "api_idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_evidence_packet_per_invoice" ON "evidence_packets" USING btree ("organization_id","extracted_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_evidence_packets_org_sealed" ON "evidence_packets" USING btree ("organization_id","sealed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_override_log_org_approved" ON "invoice_override_log" USING btree ("organization_id","approved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_override_log_invoice" ON "invoice_override_log" USING btree ("organization_id","extracted_invoice_id");