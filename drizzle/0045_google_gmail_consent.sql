DROP TRIGGER provider_connection_purpose_insert_guard;
--> statement-breakpoint
CREATE TRIGGER provider_connection_purpose_insert_guard BEFORE INSERT ON provider_connections BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar', 'calendar-publish', 'gmail') THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
--> statement-breakpoint
DROP TRIGGER provider_authorization_purpose_guard;
--> statement-breakpoint
CREATE TRIGGER provider_authorization_purpose_guard BEFORE INSERT ON provider_authorization_attempts BEGIN
  SELECT CASE WHEN NEW.purpose NOT IN ('contacts', 'calendar', 'calendar-publish', 'gmail') OR (NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_connections WHERE id = NEW.connection_id AND purpose = NEW.purpose)) THEN RAISE(ABORT, 'PROVIDER_CONNECTION_INVALID') END;
END;
