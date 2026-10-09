CREATE TABLE `contact_source_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` integer NOT NULL,
	`provider` text NOT NULL,
	`account_key` text NOT NULL,
	`external_id` text NOT NULL,
	`profile_url` text NOT NULL,
	`origin` text NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_links_workspace_public_idx` ON `contact_source_links` (`workspace_id`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_links_external_idx` ON `contact_source_links` (`workspace_id`,`provider`,`account_key`,`external_id`);--> statement-breakpoint
CREATE INDEX `source_links_contact_idx` ON `contact_source_links` (`workspace_id`,`contact_id`,`id`);