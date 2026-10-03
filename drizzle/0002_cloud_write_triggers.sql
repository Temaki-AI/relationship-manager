CREATE TRIGGER relationships_unique_pair BEFORE INSERT ON contact_relationships
WHEN EXISTS (
  SELECT 1 FROM contact_relationships WHERE workspace_id = NEW.workspace_id
    AND ((contact_id = NEW.contact_id AND related_contact_id = NEW.related_contact_id)
      OR (contact_id = NEW.related_contact_id AND related_contact_id = NEW.contact_id))
)
BEGIN
  SELECT RAISE(ABORT, 'CONTACT_RELATIONSHIP_EXISTS');
END;
--> statement-breakpoint
CREATE TRIGGER interactions_refresh_contact_insert AFTER INSERT ON interactions
BEGIN
  UPDATE contacts SET last_contacted = (
    SELECT MAX(date) FROM interactions WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id
  ), updated_at = CURRENT_TIMESTAMP WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id;
END;
--> statement-breakpoint
CREATE TRIGGER interactions_refresh_contact_delete AFTER DELETE ON interactions
BEGIN
  UPDATE contacts SET last_contacted = (
    SELECT MAX(date) FROM interactions WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.contact_id
  ), updated_at = CURRENT_TIMESTAMP WHERE workspace_id = OLD.workspace_id AND id = OLD.contact_id;
END;
--> statement-breakpoint
CREATE TRIGGER interactions_refresh_contact_update AFTER UPDATE OF date, contact_id ON interactions
BEGIN
  UPDATE contacts SET last_contacted = (
    SELECT MAX(date) FROM interactions WHERE workspace_id = contacts.workspace_id AND contact_id = contacts.id
  ), updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = NEW.workspace_id AND id IN (OLD.contact_id, NEW.contact_id);
END;
