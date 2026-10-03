CREATE TABLE `cloud_backup_files` (
	`workspace_id` text NOT NULL,
	`filename` text NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	PRIMARY KEY(`workspace_id`, `filename`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cloud_backup_pins` (
	`workspace_id` text NOT NULL,
	`filename` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `filename`, `token`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cloud_maintenance_guards` (
	`token` text PRIMARY KEY NOT NULL,
	`allowed` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `recovery_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `lifecycle` text DEFAULT 'active' NOT NULL;