DROP TRIGGER source_links_validate_insert;
--> statement-breakpoint
CREATE TRIGGER source_links_validate_insert BEFORE INSERT ON contact_source_links BEGIN
  SELECT RAISE(ABORT, 'SOURCE_LINK_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id);
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE json_valid(NEW.fields) != 1;
  SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE NEW.provider != 'linkedin' OR NEW.account_key != 'user_provided' OR NEW.origin != 'user_provided' OR NEW.external_id IS NOT NEW.profile_url OR NEW.profile_url NOT LIKE 'https://www.linkedin.com/in/%' OR length(NEW.public_id) != 36;
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields) fact WHERE fact.key NOT IN ('name', 'headline', 'company', 'location', 'title', 'email', 'connected_on') OR fact.type != 'object'
    OR (SELECT COUNT(*) FROM json_each(fact.value)) != 3
    OR COALESCE(json_type(fact.value, '$.original_value'), '') NOT IN ('null', 'text')
    OR COALESCE(json_type(fact.value, '$.observed_value'), '') NOT IN ('null', 'text')
    OR COALESCE(json_type(fact.value, '$.applied_value'), '') NOT IN ('null', 'text')
    OR length(json_extract(fact.value, '$.original_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END
    OR length(json_extract(fact.value, '$.observed_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END
    OR length(json_extract(fact.value, '$.applied_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END);
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE json_type(NEW.fields) != 'object' OR length(CAST(NEW.fields AS BLOB)) > 16384 OR NEW.revision < 1 OR typeof(NEW.revision) != 'integer';
  SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT COUNT(*) FROM contact_source_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id AND id != NEW.id) >= 32;
  
END;
--> statement-breakpoint
DROP TRIGGER source_links_validate_update;
--> statement-breakpoint
CREATE TRIGGER source_links_validate_update BEFORE UPDATE ON contact_source_links BEGIN
  SELECT RAISE(ABORT, 'SOURCE_LINK_OWNER') WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id);
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE json_valid(NEW.fields) != 1;
  SELECT RAISE(ABORT, 'CLOUD_WORKSPACE_ERASING') WHERE (SELECT lifecycle FROM workspaces WHERE id = NEW.workspace_id) != 'active';
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE NEW.provider != 'linkedin' OR NEW.account_key != 'user_provided' OR NEW.origin != 'user_provided' OR NEW.external_id IS NOT NEW.profile_url OR NEW.profile_url NOT LIKE 'https://www.linkedin.com/in/%' OR length(NEW.public_id) != 36;
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE EXISTS (SELECT 1 FROM json_each(NEW.fields) fact WHERE fact.key NOT IN ('name', 'headline', 'company', 'location', 'title', 'email', 'connected_on') OR fact.type != 'object'
    OR (SELECT COUNT(*) FROM json_each(fact.value)) != 3
    OR COALESCE(json_type(fact.value, '$.original_value'), '') NOT IN ('null', 'text')
    OR COALESCE(json_type(fact.value, '$.observed_value'), '') NOT IN ('null', 'text')
    OR COALESCE(json_type(fact.value, '$.applied_value'), '') NOT IN ('null', 'text')
    OR length(json_extract(fact.value, '$.original_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END
    OR length(json_extract(fact.value, '$.observed_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END
    OR length(json_extract(fact.value, '$.applied_value')) > CASE fact.key WHEN 'name' THEN 200 WHEN 'email' THEN 320 ELSE 500 END);
  SELECT RAISE(ABORT, 'SOURCE_LINK_INVALID') WHERE json_type(NEW.fields) != 'object' OR length(CAST(NEW.fields AS BLOB)) > 16384 OR NEW.revision < 1 OR typeof(NEW.revision) != 'integer';
  SELECT RAISE(ABORT, 'SOURCE_LINK_LIMIT') WHERE (SELECT COUNT(*) FROM contact_source_links WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.contact_id AND id != NEW.id) >= 32;
  SELECT RAISE(ABORT, 'SOURCE_LINK_IMMUTABLE') WHERE NEW.workspace_id IS NOT OLD.workspace_id OR NEW.public_id IS NOT OLD.public_id OR NEW.provider IS NOT OLD.provider OR NEW.account_key IS NOT OLD.account_key OR NEW.external_id IS NOT OLD.external_id OR NEW.profile_url IS NOT OLD.profile_url OR NEW.origin IS NOT OLD.origin;
END;
