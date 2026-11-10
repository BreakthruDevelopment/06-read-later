import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Kinds are this app's; changing the list needs a
// migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["save", "retry", "summarize", "fetch", "demo_load"] as const;
export const DAILY_USAGE_KINDS = ["save", "retry", "summarize", "fetch", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). For a link, the key is the link id. `payload` holds ids only, never the URL.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export const LINK_STATUSES = ["queued", "fetching", "extracted", "summarizing", "ready", "failed"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Stored page text. `text` is the paragraphs joined, so search can use an immutable expression. */
export type LinkContent = {
  byline?: string;
  site?: string;
  paragraphs: string[];
  text: string;
};

export const link = pgTable(
  "link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    urlHash: char("url_hash", { length: 64 }).notNull(),
    finalUrl: text("final_url"),
    host: text("host").notNull(),
    title: text("title"),
    siteName: text("site_name"),
    excerpt: text("excerpt"),
    content: jsonb("content").$type<LinkContent>(),
    wordCount: integer("word_count"),
    status: text("status", { enum: LINK_STATUSES }).notNull().default("queued"),
    failCode: text("fail_code"),
    readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
    archivedAt: timestamp("archived_at", { withTimezone: true, precision: 3 }),
    favorite: boolean("favorite").notNull().default(false),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("excerpt", '') || ' ' || coalesce("content"->>'text', ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique("link_id_owner_unique").on(t.id, t.ownerId),
    unique("link_owner_url_hash_unique").on(t.ownerId, t.urlHash),
    index("link_owner_archive_created_idx").on(t.ownerId, t.archivedAt, t.createdAt.desc()),
    index("link_search_idx").using("gin", t.search),
    check("link_status_chk", sql`${t.status} in (${list(LINK_STATUSES)})`),
    check("link_url_len_chk", sql`char_length(${t.url}) between 1 and 2048`),
    check("link_host_len_chk", sql`char_length(${t.host}) between 1 and 253`),
    check("link_title_len_chk", sql`${t.title} is null or char_length(${t.title}) <= 300`),
    check("link_site_len_chk", sql`${t.siteName} is null or char_length(${t.siteName}) <= 120`),
    check("link_excerpt_len_chk", sql`${t.excerpt} is null or char_length(${t.excerpt}) <= 300`),
    check("link_word_count_chk", sql`${t.wordCount} is null or ${t.wordCount} >= 0`),
  ],
);

export const tag = pgTable(
  "tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique("tag_id_owner_unique").on(t.id, t.ownerId),
    unique("tag_owner_name_unique").on(t.ownerId, t.name),
    check("tag_name_chk", sql`${t.name} ~ '^[a-z0-9][a-z0-9-]{1,23}$'`),
  ],
);

export const TAG_SOURCES = ["user", "ai"] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

export const linkTag = pgTable(
  "link_tag",
  {
    linkId: uuid("link_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    source: text("source", { enum: TAG_SOURCES }).notNull().default("user"),
  },
  (t) => [
    primaryKey({ columns: [t.linkId, t.tagId] }),
    foreignKey({
      columns: [t.linkId, t.ownerId],
      foreignColumns: [link.id, link.ownerId],
      name: "link_tag_link_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tagId, t.ownerId],
      foreignColumns: [tag.id, tag.ownerId],
      name: "link_tag_tag_fk",
    }).onDelete("cascade"),
    check("link_tag_source_chk", sql`${t.source} in ('user', 'ai')`),
  ],
);

/** Summary row for issue 6.3. Composite FK keeps it on the owning link. */
export const linkSummary = pgTable(
  "link_summary",
  {
    linkId: uuid("link_id").notNull(),
    ownerId: text("owner_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    mode: text("mode").notNull(),
    inputHash: text("input_hash").notNull(),
    regenerations: integer("regenerations").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.linkId] }),
    foreignKey({
      columns: [t.linkId, t.ownerId],
      foreignColumns: [link.id, link.ownerId],
      name: "link_summary_link_fk",
    }).onDelete("cascade"),
    check("link_summary_regens_chk", sql`${t.regenerations} >= 0`),
  ],
);

/** Per-host fetch politeness. No user data. The fetcher (issue 6.2) claims rows. */
export const fetchHost = pgTable("fetch_host", {
  host: text("host").primaryKey(),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  inFlight: boolean("in_flight").notNull().default(false),
});

export type User = typeof user.$inferSelect;
export type Link = typeof link.$inferSelect;
export type Tag = typeof tag.$inferSelect;
export type Job = typeof job.$inferSelect;
