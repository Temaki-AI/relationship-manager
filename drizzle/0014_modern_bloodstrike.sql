ALTER TABLE `contact_children` ADD `linked_contact_id` integer REFERENCES contacts(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `children_workspace_linked_idx` ON `contact_children` (`workspace_id`,`contact_id`,`linked_contact_id`);--> statement-breakpoint
CREATE INDEX `children_linked_contact_idx` ON `contact_children` (`linked_contact_id`);--> statement-breakpoint
CREATE TRIGGER contact_children_link_guard_insert BEFORE INSERT ON contact_children
WHEN NEW.linked_contact_id IS NOT NULL AND (
  NEW.linked_contact_id = NEW.contact_id OR NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = NEW.linked_contact_id AND workspace_id = NEW.workspace_id
  )
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_CHILD_LINK_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER contact_children_link_guard_update BEFORE UPDATE ON contact_children
WHEN NEW.linked_contact_id IS NOT NULL AND (
  NEW.linked_contact_id = NEW.contact_id OR NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = NEW.linked_contact_id AND workspace_id = NEW.workspace_id
  )
)
BEGIN SELECT RAISE(ABORT, 'CLOUD_CHILD_LINK_INVALID'); END;
