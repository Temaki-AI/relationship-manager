CREATE TABLE `mutation_receipts` (
	`workspace_id` text NOT NULL,
	`scope` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`owner_token` text NOT NULL,
	`resource_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `scope`, `request_key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
