CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `contact_children` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`name` text NOT NULL,
	`birthday` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `children_workspace_contact_idx` ON `contact_children` (`workspace_id`,`contact_id`,`id`);--> statement-breakpoint
CREATE TABLE `contact_group_members` (
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `contact_id`, `group_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `contact_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_workspace_group_idx` ON `contact_group_members` (`workspace_id`,`group_id`,`contact_id`);--> statement-breakpoint
CREATE TABLE `contact_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_workspace_name_idx` ON `contact_groups` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `contact_relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`related_contact_id` integer NOT NULL,
	`relationship_label` text NOT NULL,
	`reciprocal_label` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relationships_workspace_contact_idx` ON `contact_relationships` (`workspace_id`,`contact_id`,`id`);--> statement-breakpoint
CREATE INDEX `relationships_workspace_related_idx` ON `contact_relationships` (`workspace_id`,`related_contact_id`,`id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`nickname` text,
	`email` text,
	`phone` text,
	`photo_url` text,
	`birthday` text,
	`birthday_reminder_days` integer DEFAULT 7 NOT NULL,
	`how_we_met` text,
	`tags` text,
	`notes` text,
	`gift_ideas` text,
	`custom_fields` text,
	`last_contacted` text,
	`contact_frequency` integer DEFAULT 14,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_workspace_name_idx` ON `contacts` (`workspace_id`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `contacts_workspace_last_contacted_idx` ON `contacts` (`workspace_id`,`last_contacted`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`account_email` text,
	`last_synced_at` text,
	`sync_frequency_minutes` integer DEFAULT 60 NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_workspace_provider_idx` ON `integration_connections` (`workspace_id`,`provider`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`summary` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interactions_workspace_contact_date_idx` ON `interactions` (`workspace_id`,`contact_id`,`date`,`id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`type` text NOT NULL,
	`planned_date` text NOT NULL,
	`summary` text,
	`notes` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_workspace_contact_date_idx` ON `plans` (`workspace_id`,`contact_id`,`planned_date`,`id`);--> statement-breakpoint
CREATE TABLE `relationship_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`value` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`last_verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `facts_workspace_contact_idx` ON `relationship_facts` (`workspace_id`,`contact_id`,`id`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`remind_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reminders_workspace_due_idx` ON `reminders` (`workspace_id`,`completed_at`,`remind_at`,`id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	`metadata` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_jobs_workspace_provider_idx` ON `sync_jobs` (`workspace_id`,`provider`,`started_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`persona` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
