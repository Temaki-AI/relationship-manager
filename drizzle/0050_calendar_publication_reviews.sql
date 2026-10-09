CREATE TABLE `calendar_publication_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`plan_public_id` text NOT NULL,
	`reviewing_device_id` text NOT NULL,
	`epoch` text NOT NULL,
	`expected_revision` integer,
	`plan_fingerprint` text NOT NULL,
	`observed_marker` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_publication_reviews_receipt_idx` ON `calendar_publication_reviews` (`workspace_id`,`receipt_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER calendar_publication_review_insert_guard BEFORE INSERT ON calendar_publication_reviews BEGIN
  SELECT CASE WHEN length(NEW.id) != 36 OR length(NEW.receipt_id) != 36 OR NEW.id = NEW.receipt_id
    OR length(NEW.plan_public_id) != 36 OR length(NEW.reviewing_device_id) != 36 OR length(NEW.epoch) != 36
    OR length(NEW.plan_fingerprint) != 64 OR length(NEW.request_fingerprint) != 64
    OR NEW.observed_marker IS NOT ('bonds://calendar/apple/' || NEW.plan_public_id || '?receipt=' || NEW.receipt_id)
    OR NEW.expected_revision IS NOT NULL AND (typeof(NEW.expected_revision) != 'integer' OR NEW.expected_revision < 1)
    OR (SELECT count(*) FROM calendar_publication_reviews WHERE workspace_id = NEW.workspace_id) >= 25000
    OR NOT EXISTS (SELECT 1 FROM device_sessions d JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
      JOIN workspace_sync_state s ON s.workspace_id = d.workspace_id JOIN workspaces w ON w.id = d.workspace_id
      JOIN plans p ON p.workspace_id = d.workspace_id AND p.public_id = NEW.plan_public_id
      WHERE d.id = NEW.reviewing_device_id AND d.workspace_id = NEW.workspace_id AND d.user_id = NEW.user_id
        AND d.revoked_at IS NULL AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND m.role = 'owner' AND w.lifecycle = 'active' AND s.paused = 0 AND s.epoch = NEW.epoch)
    OR (NEW.expected_revision IS NULL AND (
      EXISTS (SELECT 1 FROM calendar_publication_reservations r WHERE r.workspace_id = NEW.workspace_id
        AND (r.id = NEW.receipt_id OR r.plan_public_id = NEW.plan_public_id AND r.status != 'cancelled'))
      OR EXISTS (SELECT 1 FROM calendar_event_plans l JOIN plans p ON p.id = l.plan_id AND p.workspace_id = l.workspace_id
        WHERE p.workspace_id = NEW.workspace_id AND p.public_id = NEW.plan_public_id)))
    OR (NEW.expected_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar_publication_reservations r
      WHERE r.id = NEW.receipt_id AND r.workspace_id = NEW.workspace_id AND r.user_id = NEW.user_id AND r.plan_public_id = NEW.plan_public_id
        AND r.provider = 'apple-calendar' AND r.status != 'cancelled' AND r.revision = NEW.expected_revision))
    THEN RAISE(ABORT, 'CALENDAR_PUBLICATION_REVIEW_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_publication_review_immutable BEFORE UPDATE ON calendar_publication_reviews BEGIN
  SELECT RAISE(ABORT, 'CALENDAR_PUBLICATION_REVIEW_IMMUTABLE');
END;
--> statement-breakpoint
DROP TRIGGER calendar_reservation_insert_guard;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_insert_guard BEFORE INSERT ON calendar_publication_reservations BEGIN
  SELECT CASE WHEN length(NEW.id) != 36 OR length(NEW.plan_public_id) != 36 OR length(NEW.publisher_id) != 36 OR length(NEW.epoch) != 36
    OR NEW.provider NOT IN ('google-calendar', 'apple-calendar') OR NEW.result_action IS NOT NULL OR NEW.revision != 1
    OR NOT (
      (NEW.status = 'reserved' AND NEW.attempted = 0
        AND (NEW.provider != 'apple-calendar' OR (length(NEW.plan_fingerprint) = 64 AND length(NEW.request_fingerprint) = 64
          AND NEW.plan_fingerprint IS NOT NULL AND NEW.request_fingerprint IS NOT NULL
          AND EXISTS (SELECT 1 FROM device_sessions d JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
            JOIN workspace_sync_state s ON s.workspace_id = d.workspace_id JOIN workspaces w ON w.id = d.workspace_id
            JOIN plans p ON p.workspace_id = d.workspace_id AND p.public_id = NEW.plan_public_id
            WHERE d.id = NEW.publisher_id AND d.workspace_id = NEW.workspace_id AND d.user_id = NEW.user_id
              AND d.revoked_at IS NULL AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              AND m.role = 'owner' AND w.lifecycle = 'active' AND s.paused = 0 AND s.epoch = NEW.epoch AND p.completed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM calendar_event_plans l JOIN plans p ON p.id = l.plan_id AND p.workspace_id = l.workspace_id
            WHERE p.workspace_id = NEW.workspace_id AND p.public_id = NEW.plan_public_id)))
        AND (NEW.provider != 'google-calendar' OR EXISTS (SELECT 1 FROM calendar_plan_publications p JOIN provider_connections c ON c.id = p.connection_id
          WHERE p.id = NEW.id AND p.workspace_id = NEW.workspace_id AND p.user_id = NEW.user_id AND p.connection_id = NEW.publisher_id
            AND p.plan_public_id = NEW.plan_public_id AND c.dataset_epoch = NEW.epoch)))
      OR (NEW.provider = 'apple-calendar' AND NEW.status = 'saved' AND NEW.attempted = 1
        AND EXISTS (SELECT 1 FROM calendar_publication_reviews v WHERE v.receipt_id = NEW.id AND v.workspace_id = NEW.workspace_id
          AND v.user_id = NEW.user_id AND v.plan_public_id = NEW.plan_public_id AND v.reviewing_device_id = NEW.publisher_id
          AND v.epoch = NEW.epoch AND v.expected_revision IS NULL AND v.plan_fingerprint = NEW.plan_fingerprint AND v.request_fingerprint = NEW.request_fingerprint))
    ) THEN RAISE(ABORT, 'CALENDAR_RESERVATION_INVALID') END;
END;
