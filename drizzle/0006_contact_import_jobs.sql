CREATE TABLE `contact_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`filename` text NOT NULL,
	`format` text NOT NULL,
	`total` integer NOT NULL,
	`source_bytes` integer NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_request_idx` ON `contact_import_jobs` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_owner_idx` ON `contact_import_jobs` (`id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `import_jobs_workspace_idx` ON `contact_import_jobs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contact_import_rows` (
	`workspace_id` text NOT NULL,
	`job_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`birthday` text,
	`payload` text,
	`state` text NOT NULL,
	`force_create` integer DEFAULT 0 NOT NULL,
	`message` text,
	`contact_id` integer,
	PRIMARY KEY(`job_id`, `row_number`),
	FOREIGN KEY (`job_id`,`workspace_id`) REFERENCES `contact_import_jobs`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_rows_state_idx` ON `contact_import_rows` (`workspace_id`,`job_id`,`state`,`row_number`);--> statement-breakpoint
CREATE TABLE `contact_import_sources` (
	`workspace_id` text NOT NULL,
	`job_id` text NOT NULL,
	`part` integer NOT NULL,
	`data` blob NOT NULL,
	PRIMARY KEY(`job_id`, `part`),
	FOREIGN KEY (`job_id`,`workspace_id`) REFERENCES `contact_import_jobs`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
