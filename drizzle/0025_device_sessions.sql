CREATE TABLE `device_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`challenge` text NOT NULL,
	`state` text NOT NULL,
	`device_name` text NOT NULL,
	`expires_at` text NOT NULL,
	`device_id` text,
	`consumed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_codes_user_expiry_idx` ON `device_authorization_codes` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_name` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_sessions_token_hash_unique` ON `device_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_sessions_owner_idx` ON `device_sessions` (`workspace_id`,`user_id`,`expires_at`);