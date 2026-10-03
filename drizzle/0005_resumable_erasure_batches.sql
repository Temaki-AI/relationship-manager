CREATE TABLE `cloud_erasure_batches` (
	`workspace_id` text NOT NULL,
	`token` text NOT NULL,
	`object_keys` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `token`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
