CREATE TABLE "fetch_host" (
	"host" text PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"in_flight" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"owner_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"lock_token" uuid,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "job_status_chk" CHECK ("job"."status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "job_attempts_chk" CHECK ("job"."attempts" >= 0 and "job"."max_attempts" >= 1 and "job"."deferrals" >= 0)
);
--> statement-breakpoint
CREATE TABLE "link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"url" text NOT NULL,
	"url_hash" char(64) NOT NULL,
	"final_url" text,
	"host" text NOT NULL,
	"title" text,
	"site_name" text,
	"excerpt" text,
	"content" jsonb,
	"word_count" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"fail_code" text,
	"read_at" timestamp (3) with time zone,
	"archived_at" timestamp (3) with time zone,
	"favorite" boolean DEFAULT false NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("excerpt", '') || ' ' || coalesce("content"->>'text', ''))) STORED,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "link_owner_url_hash_unique" UNIQUE("owner_id","url_hash"),
	CONSTRAINT "link_status_chk" CHECK ("link"."status" in ('queued', 'fetching', 'extracted', 'summarizing', 'ready', 'failed')),
	CONSTRAINT "link_url_len_chk" CHECK (char_length("link"."url") between 1 and 2048),
	CONSTRAINT "link_host_len_chk" CHECK (char_length("link"."host") between 1 and 253),
	CONSTRAINT "link_title_len_chk" CHECK ("link"."title" is null or char_length("link"."title") <= 300),
	CONSTRAINT "link_site_len_chk" CHECK ("link"."site_name" is null or char_length("link"."site_name") <= 120),
	CONSTRAINT "link_excerpt_len_chk" CHECK ("link"."excerpt" is null or char_length("link"."excerpt") <= 300),
	CONSTRAINT "link_word_count_chk" CHECK ("link"."word_count" is null or "link"."word_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "link_summary" (
	"link_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"mode" text NOT NULL,
	"input_hash" text NOT NULL,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_summary_link_id_pk" PRIMARY KEY("link_id"),
	CONSTRAINT "link_summary_regens_chk" CHECK ("link_summary"."regenerations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "link_tag" (
	"link_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "link_tag_link_id_tag_id_pk" PRIMARY KEY("link_id","tag_id"),
	CONSTRAINT "link_tag_source_chk" CHECK ("link_tag"."source" in ('user', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "tag_owner_name_unique" UNIQUE("owner_id","name"),
	CONSTRAINT "tag_name_chk" CHECK ("tag"."name" ~ '^[a-z0-9][a-z0-9-]{1,23}$')
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "daily_usage" DROP CONSTRAINT "daily_usage_kind_chk";--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_summary" ADD CONSTRAINT "link_summary_link_fk" FOREIGN KEY ("link_id","owner_id") REFERENCES "public"."link"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_tag" ADD CONSTRAINT "link_tag_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_tag" ADD CONSTRAINT "link_tag_link_fk" FOREIGN KEY ("link_id","owner_id") REFERENCES "public"."link"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_tag" ADD CONSTRAINT "link_tag_tag_fk" FOREIGN KEY ("tag_id","owner_id") REFERENCES "public"."tag"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_active_key_uidx" ON "job" USING btree ("kind","key") WHERE "job"."status" in ('queued', 'running') and "job"."key" is not null;--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "job" USING btree ("run_after") WHERE "job"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "job_lease_idx" ON "job" USING btree ("locked_until") WHERE "job"."status" = 'running';--> statement-breakpoint
CREATE INDEX "job_kind_key_idx" ON "job" USING btree ("kind","key","created_at");--> statement-breakpoint
CREATE INDEX "job_owner_idx" ON "job" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "link_owner_archive_created_idx" ON "link" USING btree ("owner_id","archived_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "link_search_idx" ON "link" USING gin ("search");--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('save', 'retry', 'summarize', 'fetch', 'demo_load'));--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('save', 'retry', 'summarize', 'fetch', 'demo_load'));