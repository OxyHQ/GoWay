-- oxy:deploy-phase=pre
CREATE TABLE "oxy_file_reference_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"from_entity_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_changes_action_check" CHECK ("oxy_file_reference_changes"."action" in ('add', 'remove', 'move')),
	CONSTRAINT "oxy_file_reference_changes_entity_type_check" CHECK ("oxy_file_reference_changes"."entity_type" in ('place')),
	CONSTRAINT "oxy_file_reference_changes_state_check" CHECK ("oxy_file_reference_changes"."state" in ('pending', 'dead')),
	CONSTRAINT "oxy_file_reference_changes_move_check" CHECK (("oxy_file_reference_changes"."action" = 'move') = ("oxy_file_reference_changes"."from_entity_id" is not null)),
	CONSTRAINT "oxy_file_reference_changes_attempts_check" CHECK ("oxy_file_reference_changes"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"added" integer,
	"removed" integer,
	"unchanged" integer,
	"refused" integer,
	"sent" integer,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('place'))
);
--> statement-breakpoint
CREATE INDEX "oxy_file_reference_changes_due_idx" ON "oxy_file_reference_changes" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_changes_file_idx" ON "oxy_file_reference_changes" USING btree ("oxy_file_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_reference_reconciliations_open_idx" ON "oxy_file_reference_reconciliations" USING btree ("entity_type") WHERE "oxy_file_reference_reconciliations"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "oxy_file_reference_reconciliations_recent_idx" ON "oxy_file_reference_reconciliations" USING btree ("entity_type","started_at");