CREATE TABLE `calendar_publication_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`plan_public_id` text NOT NULL,
	`provider` text NOT NULL,
	`publisher_id` text NOT NULL,
	`epoch` text NOT NULL,
	`plan_fingerprint` text,
	`request_fingerprint` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`attempted` integer DEFAULT 0 NOT NULL,
	`result_action` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_reservations_live_plan_idx` ON `calendar_publication_reservations` (`workspace_id`,`plan_public_id`) WHERE "calendar_publication_reservations"."status" != 'cancelled';--> statement-breakpoint
CREATE INDEX `calendar_reservations_workspace_idx` ON `calendar_publication_reservations` (`workspace_id`,`created_at`);
--> statement-breakpoint
INSERT INTO calendar_publication_reservations
  (id, workspace_id, user_id, plan_public_id, provider, publisher_id, epoch, status, attempted, created_at, updated_at)
SELECT p.id, p.workspace_id, p.user_id, p.plan_public_id, 'google-calendar', p.connection_id, c.dataset_epoch,
  CASE WHEN p.status IN ('held', 'missing') THEN 'held' WHEN p.confirmed_at IS NOT NULL THEN 'saved'
    WHEN EXISTS (SELECT 1 FROM calendar_plan_writes x WHERE x.publication_id = p.id AND x.attempts > 0) THEN 'attempted' ELSE 'reserved' END,
  CASE WHEN p.confirmed_at IS NOT NULL OR EXISTS (SELECT 1 FROM calendar_plan_writes x WHERE x.publication_id = p.id AND x.attempts > 0) THEN 1 ELSE 0 END,
  p.created_at, p.updated_at
FROM calendar_plan_publications p JOIN provider_connections c ON c.id = p.connection_id;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_insert_guard BEFORE INSERT ON calendar_publication_reservations BEGIN
  SELECT CASE WHEN length(NEW.id) != 36 OR length(NEW.plan_public_id) != 36 OR length(NEW.publisher_id) != 36 OR length(NEW.epoch) != 36
    OR NEW.provider NOT IN ('google-calendar', 'apple-calendar') OR NEW.status != 'reserved' OR NEW.attempted != 0
    OR NEW.result_action IS NOT NULL OR NEW.revision != 1
    OR (NEW.provider = 'apple-calendar' AND (length(NEW.plan_fingerprint) != 64 OR length(NEW.request_fingerprint) != 64
      OR NEW.plan_fingerprint IS NULL OR NEW.request_fingerprint IS NULL
      OR NOT EXISTS (SELECT 1 FROM device_sessions d JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
        JOIN workspace_sync_state s ON s.workspace_id = d.workspace_id JOIN workspaces w ON w.id = d.workspace_id
        JOIN plans p ON p.workspace_id = d.workspace_id AND p.public_id = NEW.plan_public_id
        WHERE d.id = NEW.publisher_id AND d.workspace_id = NEW.workspace_id AND d.user_id = NEW.user_id
          AND d.revoked_at IS NULL AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND m.role = 'owner' AND w.lifecycle = 'active' AND s.paused = 0 AND s.epoch = NEW.epoch AND p.completed_at IS NULL)
      OR EXISTS (SELECT 1 FROM calendar_event_plans l JOIN plans p ON p.id = l.plan_id AND p.workspace_id = l.workspace_id
        WHERE p.workspace_id = NEW.workspace_id AND p.public_id = NEW.plan_public_id)))
    OR (NEW.provider = 'google-calendar' AND NOT EXISTS (SELECT 1 FROM calendar_plan_publications p JOIN provider_connections c ON c.id = p.connection_id
      WHERE p.id = NEW.id AND p.workspace_id = NEW.workspace_id AND p.user_id = NEW.user_id AND p.connection_id = NEW.publisher_id
        AND p.plan_public_id = NEW.plan_public_id AND c.dataset_epoch = NEW.epoch))
    THEN RAISE(ABORT, 'CALENDAR_RESERVATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_update_guard BEFORE UPDATE ON calendar_publication_reservations BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.plan_public_id IS NOT OLD.plan_public_id OR NEW.provider IS NOT OLD.provider OR NEW.publisher_id IS NOT OLD.publisher_id
    OR NEW.epoch IS NOT OLD.epoch OR NEW.plan_fingerprint IS NOT OLD.plan_fingerprint OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
    OR NEW.created_at IS NOT OLD.created_at OR typeof(NEW.revision) != 'integer' OR NEW.revision <= OLD.revision
    OR NEW.status NOT IN ('reserved', 'attempted', 'saved', 'cancelled', 'held') OR NEW.attempted NOT IN (0, 1) OR NEW.attempted < OLD.attempted
    OR (OLD.result_action IS NOT NULL AND NEW.result_action IS NOT OLD.result_action)
    OR (NEW.result_action IS NOT NULL AND NEW.result_action NOT IN ('saved', 'canceled'))
    OR (OLD.status = 'cancelled' AND NEW.status != 'cancelled')
    OR (NEW.status IN ('attempted', 'saved') AND NEW.attempted != 1) OR (NEW.status = 'reserved' AND NEW.attempted != 0)
    OR (NEW.status = 'cancelled' AND NEW.attempted = 1 AND NEW.result_action IS NOT 'canceled')
    OR (NEW.provider = 'google-calendar' AND NEW.status = 'cancelled')
    THEN RAISE(ABORT, 'CALENDAR_RESERVATION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_google_insert AFTER INSERT ON calendar_plan_publications BEGIN
  INSERT INTO calendar_publication_reservations
    (id, workspace_id, user_id, plan_public_id, provider, publisher_id, epoch, created_at, updated_at)
    SELECT NEW.id, NEW.workspace_id, NEW.user_id, NEW.plan_public_id, 'google-calendar', NEW.connection_id, c.dataset_epoch, NEW.created_at, NEW.updated_at
    FROM provider_connections c WHERE c.id = NEW.connection_id;
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_google_attempt AFTER UPDATE OF attempts ON calendar_plan_writes WHEN NEW.attempts > OLD.attempts BEGIN
  UPDATE calendar_publication_reservations SET attempted = 1,
    status = CASE WHEN status = 'held' THEN 'held' ELSE 'attempted' END, revision = revision + 1, updated_at = NEW.updated_at
    WHERE id = NEW.publication_id AND provider = 'google-calendar';
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_google_state AFTER UPDATE OF status, confirmed_at, updated_at ON calendar_plan_publications
WHEN NEW.status IS NOT OLD.status OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.updated_at IS NOT OLD.updated_at BEGIN
  UPDATE calendar_publication_reservations SET
    status = CASE WHEN NEW.status IN ('held', 'missing') THEN 'held' WHEN NEW.confirmed_at IS NOT NULL THEN 'saved'
      WHEN attempted = 1 THEN 'attempted' ELSE 'reserved' END,
    attempted = CASE WHEN NEW.confirmed_at IS NOT NULL THEN 1 ELSE attempted END,
    revision = revision + 1, updated_at = NEW.updated_at WHERE id = NEW.id AND provider = 'google-calendar';
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_restore AFTER UPDATE OF epoch ON workspace_sync_state WHEN NEW.epoch IS NOT OLD.epoch BEGIN
  UPDATE calendar_publication_reservations SET status = 'held', revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE workspace_id = NEW.workspace_id AND status NOT IN ('held', 'cancelled');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_plan_delete AFTER DELETE ON plans BEGIN
  UPDATE calendar_publication_reservations SET status = 'held', revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE workspace_id = OLD.workspace_id AND plan_public_id = OLD.public_id AND status NOT IN ('held', 'cancelled');
END;
--> statement-breakpoint
CREATE TRIGGER calendar_reservation_device_revoke AFTER UPDATE OF revoked_at ON device_sessions WHEN NEW.revoked_at IS NOT OLD.revoked_at AND NEW.revoked_at IS NOT NULL BEGIN
  UPDATE calendar_publication_reservations SET status = 'held', revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE publisher_id = NEW.id AND provider = 'apple-calendar' AND status NOT IN ('held', 'cancelled');
END;
