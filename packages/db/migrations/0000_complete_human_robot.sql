CREATE TYPE "public"."grain" AS ENUM('day', 'week', 'month', 'sprint');--> statement-breakpoint
CREATE TYPE "public"."iteration_state" AS ENUM('future', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('csv', 'manual', 'github', 'jira', 'linear', 'asana');--> statement-breakpoint
CREATE TYPE "public"."status_category" AS ENUM('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "impediments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"kind_term_id" uuid,
	"severity_term_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"owner_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_rejects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"row_number" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_source_id" uuid,
	"correlation_id" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"error" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iterations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"goal" text,
	"start_date" date,
	"end_date" date,
	"state" "iteration_state" DEFAULT 'future' NOT NULL,
	"committed_points" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"portfolio_id" uuid,
	"metric_key" text NOT NULL,
	"grain" "grain" DEFAULT 'week' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"value" numeric(16, 4),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"description" text,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"display_name" text NOT NULL,
	"email" text,
	"role" text,
	"avatar_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status_term_id" uuid,
	"health_term_id" uuid,
	"owner_id" uuid,
	"start_date" date,
	"target_date" date,
	"actual_end_date" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'dashboard' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"work_item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"from_term_id" uuid,
	"to_term_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"from_category" "status_category",
	"to_category" "status_category" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_in_from_seconds" integer,
	"actor_id" uuid,
	"ingestion_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"drives_status_category" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taxonomy_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"color" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"status_category" "status_category",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"iteration_id" uuid,
	"milestone_id" uuid,
	"parent_id" uuid,
	"source" "source_kind" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"key" text,
	"type_term_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status_term_id" uuid,
	"status_raw" text,
	"status_category" "status_category" DEFAULT 'todo' NOT NULL,
	"priority_term_id" uuid,
	"estimate" numeric(10, 2),
	"time_spent_hours" numeric(10, 2),
	"assignee_id" uuid,
	"reporter_id" uuid,
	"source_created_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"due_date" date,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingestion_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "impediments" ADD CONSTRAINT "impediments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impediments" ADD CONSTRAINT "impediments_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impediments" ADD CONSTRAINT "impediments_kind_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("kind_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impediments" ADD CONSTRAINT "impediments_severity_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("severity_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impediments" ADD CONSTRAINT "impediments_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_rejects" ADD CONSTRAINT "ingestion_rejects_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("status_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_health_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("health_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_from_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("from_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_to_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("to_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_parent_id_work_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_type_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("type_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_status_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("status_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_priority_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("priority_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_people_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_reporter_id_people_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_name_idx" ON "data_sources" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "impediments_source_external_idx" ON "impediments" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "impediments_project_idx" ON "impediments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "impediments_open_idx" ON "impediments" USING btree ("project_id","resolved_at","severity_term_id");--> statement-breakpoint
CREATE INDEX "impediments_category_idx" ON "impediments" USING btree ("category");--> statement-breakpoint
CREATE INDEX "impediments_kind_idx" ON "impediments" USING btree ("kind_term_id");--> statement-breakpoint
CREATE INDEX "rejects_run_idx" ON "ingestion_rejects" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "runs_source_idx" ON "ingestion_runs" USING btree ("data_source_id");--> statement-breakpoint
CREATE INDEX "runs_started_idx" ON "ingestion_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_correlation_idx" ON "ingestion_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "iterations_source_external_idx" ON "iterations" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "iterations_project_idx" ON "iterations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "iterations_dates_idx" ON "iterations" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_snapshots_unique_idx" ON "metric_snapshots" USING btree ("project_id","metric_key","grain","period_start");--> statement-breakpoint
CREATE INDEX "metric_snapshots_lookup_idx" ON "metric_snapshots" USING btree ("metric_key","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_source_external_idx" ON "milestones" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_due_idx" ON "milestones" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "people_source_external_idx" ON "people" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "people_name_idx" ON "people" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_key_idx" ON "portfolios" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_key_idx" ON "projects" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_source_external_idx" ON "projects" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "projects_portfolio_idx" ON "projects" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status_term_id");--> statement-breakpoint
CREATE INDEX "projects_health_idx" ON "projects" USING btree ("health_term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_name_kind_idx" ON "saved_views" USING btree ("name","kind");--> statement-breakpoint
CREATE INDEX "transitions_item_time_idx" ON "status_transitions" USING btree ("work_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transitions_project_time_idx" ON "status_transitions" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transitions_to_category_idx" ON "status_transitions" USING btree ("to_category");--> statement-breakpoint
CREATE UNIQUE INDEX "transitions_dedupe_idx" ON "status_transitions" USING btree ("work_item_id","to_status","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomies_key_idx" ON "taxonomies" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_terms_slug_idx" ON "taxonomy_terms" USING btree ("taxonomy_id","slug");--> statement-breakpoint
CREATE INDEX "taxonomy_terms_taxonomy_idx" ON "taxonomy_terms" USING btree ("taxonomy_id","sort_order");--> statement-breakpoint
CREATE INDEX "taxonomy_terms_active_idx" ON "taxonomy_terms" USING btree ("taxonomy_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_source_external_idx" ON "work_items" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "work_items_project_idx" ON "work_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "work_items_iteration_idx" ON "work_items" USING btree ("iteration_id");--> statement-breakpoint
CREATE INDEX "work_items_type_idx" ON "work_items" USING btree ("type_term_id");--> statement-breakpoint
CREATE INDEX "work_items_status_term_idx" ON "work_items" USING btree ("status_term_id");--> statement-breakpoint
CREATE INDEX "work_items_milestone_idx" ON "work_items" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "work_items_parent_idx" ON "work_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "work_items_category_idx" ON "work_items" USING btree ("status_category");--> statement-breakpoint
CREATE INDEX "work_items_assignee_idx" ON "work_items" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "work_items_completed_idx" ON "work_items" USING btree ("project_id","completed_at");--> statement-breakpoint
CREATE INDEX "work_items_started_idx" ON "work_items" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "work_items_blocked_idx" ON "work_items" USING btree ("is_blocked");