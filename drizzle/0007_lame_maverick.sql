CREATE TABLE `contact_export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_key` text NOT NULL,
	`format` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`revision` integer NOT NULL,
	`total` integer NOT NULL,
	`max_id` integer NOT NULL,
	`exported` integer DEFAULT 0 NOT NULL,
	`cursor_id` integer DEFAULT 0 NOT NULL,
	`upload_id` text,
	`part_etags` text DEFAULT '[]' NOT NULL,
	`scratch_size` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_jobs_request_idx` ON `contact_export_jobs` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `export_jobs_workspace_idx` ON `contact_export_jobs` (`workspace_id`,`created_at`);