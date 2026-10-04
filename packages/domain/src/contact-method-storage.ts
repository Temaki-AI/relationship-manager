/** SQL shared by D1, the self-hosted database and phone cache. UUIDs remain persisted. */
const uuid = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;
function method(kind: string, value: string, source: string, preferred: string, label = 'NULL') {
  return `json_object('id', ${uuid}, 'kind', '${kind}', 'value', ${value}, 'label', ${label}, 'country', NULL,
    'preferred', json(${preferred}), 'source', '${source}', 'source_value', ${source === 'legacy' ? value : 'NULL'}, 'user_override', json('${source === 'manual' ? 'true' : 'false'}'))`;
}
export function contactMethodsBackfillSql(customFields = true) {
  const extra = customFields ? `
    UNION ALL SELECT ${method('email', 'value', 'legacy', "'false'")} FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.vcard.additional_emails') ELSE '[]' END) WHERE type = 'text' AND trim(value) != ''
    UNION ALL SELECT ${method('phone', 'value', 'legacy', "'false'")} FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.vcard.additional_phones') ELSE '[]' END) WHERE type = 'text' AND trim(value) != ''
    UNION ALL SELECT ${method('profile', 'value', 'legacy', "'false'", 'key')} FROM json_each(CASE WHEN json_valid(contacts.custom_fields) THEN json_extract(contacts.custom_fields, '$.social') ELSE '{}' END) WHERE type = 'text' AND trim(value) != ''` : '';
  return `UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT ${method('email', 'contacts.email', 'legacy', "'true'")} AS item WHERE contacts.email IS NOT NULL AND trim(contacts.email) != ''
    UNION ALL SELECT ${method('phone', 'contacts.phone', 'legacy', "'true'")} WHERE contacts.phone IS NOT NULL AND trim(contacts.phone) != '' ${extra}
  ));`;
}
export function contactMethodsTriggersSql() {
  const append = (kind: string) => `SELECT ${method(kind, `NEW.${kind}`, 'manual', "'true'")} AS item WHERE NEW.${kind} IS NOT NULL AND trim(NEW.${kind}) != ''
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = '${kind}' AND json_extract(value, '$.preferred') = 1)`;
  const extras = ['email', 'phone', 'profile'].map((kind) => {
    const path = kind === 'email' ? '$.vcard.additional_emails' : kind === 'phone' ? '$.vcard.additional_phones' : '$.social';
    return `SELECT ${method(kind, 'value', 'manual', "'false'", kind === 'profile' ? 'key' : 'NULL')} AS item FROM json_each(CASE WHEN json_valid(NEW.custom_fields) THEN json_extract(NEW.custom_fields, '${path}') ELSE '[]' END)
      WHERE NEW.contact_methods = 'null' AND type = 'text' AND trim(value) != ''`;
  }).join('\nUNION ALL ');
  const update = (kind: string) => `WHEN json_extract(value, '$.kind') = '${kind}' AND json_extract(value, '$.preferred') = 1 AND NEW.${kind} IS NOT OLD.${kind} AND json_extract(value, '$.value') IS NOT NEW.${kind}
    THEN json_set(value, '$.value', NEW.${kind}, '$.user_override', json('true'))`;
  const validate = `
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT 1 FROM json_each(NEW.contact_methods)
    WHERE type != 'object' OR COALESCE(json_type(value, '$.id'), '') != 'text' OR length(json_extract(value, '$.id')) != 36
      OR length(replace(json_extract(value, '$.id'), '-', '')) != 32 OR json_extract(value, '$.id') GLOB '*[^a-f0-9-]*'
      OR substr(json_extract(value, '$.id'), 9, 1) != '-' OR substr(json_extract(value, '$.id'), 14, 1) != '-'
      OR substr(json_extract(value, '$.id'), 19, 1) != '-' OR substr(json_extract(value, '$.id'), 24, 1) != '-'
      OR substr(json_extract(value, '$.id'), 15, 1) NOT GLOB '[1-8]' OR substr(json_extract(value, '$.id'), 20, 1) NOT GLOB '[89ab]'
      OR COALESCE(json_extract(value, '$.kind'), '') NOT IN ('email', 'phone', 'profile')
      OR COALESCE(json_type(value, '$.value'), '') != 'text' OR length(trim(json_extract(value, '$.value'))) = 0
      OR length(json_extract(value, '$.value')) > CASE json_extract(value, '$.kind') WHEN 'email' THEN 320 WHEN 'phone' THEN 100 ELSE 2048 END
      OR COALESCE(json_type(value, '$.label'), '') NOT IN ('null', 'text') OR length(json_extract(value, '$.label')) > 80
      OR COALESCE(json_type(value, '$.country'), '') NOT IN ('null', 'text') OR (json_type(value, '$.country') = 'text'
        AND (json_extract(value, '$.kind') != 'phone' OR length(json_extract(value, '$.country')) != 2 OR json_extract(value, '$.country') GLOB '*[^A-Z]*'))
      OR COALESCE(json_type(value, '$.preferred'), '') NOT IN ('true', 'false')
      OR COALESCE(json_type(value, '$.user_override'), '') NOT IN ('true', 'false')
      OR COALESCE(json_extract(value, '$.source'), '') NOT IN ('manual', 'legacy')
      OR (json_extract(value, '$.source') = 'manual' AND (COALESCE(json_type(value, '$.source_value'), '') != 'null' OR json_extract(value, '$.user_override') != 1))
      OR (json_extract(value, '$.source') = 'legacy' AND COALESCE(json_type(value, '$.source_value'), '') != 'text'));
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.id') FROM json_each(NEW.contact_methods) GROUP BY json_extract(value, '$.id') HAVING COUNT(*) > 1);
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE NEW.contact_methods != 'null' AND EXISTS (SELECT json_extract(value, '$.kind') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.preferred') = 1 GROUP BY json_extract(value, '$.kind') HAVING COUNT(*) > 1);
`;
  return `
CREATE TRIGGER IF NOT EXISTS contact_methods_shape_insert BEFORE INSERT ON contacts BEGIN
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_valid(NEW.contact_methods) != 1;
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE (json_type(NEW.contact_methods) != 'array' AND NEW.contact_methods != 'null') OR json_array_length(NEW.contact_methods) > 256 OR length(CAST(NEW.contact_methods AS BLOB)) > 393216;
  ${validate}
END;
CREATE TRIGGER IF NOT EXISTS contact_methods_shape_update BEFORE UPDATE OF contact_methods ON contacts BEGIN
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_valid(NEW.contact_methods) != 1;
  SELECT RAISE(ABORT, 'CONTACT_METHODS_INVALID') WHERE json_type(NEW.contact_methods) != 'array' OR json_array_length(NEW.contact_methods) > 256 OR length(CAST(NEW.contact_methods AS BLOB)) > 393216;
  ${validate}
END;
CREATE TRIGGER IF NOT EXISTS contact_methods_primary_insert AFTER INSERT ON contacts BEGIN
  UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT value AS item FROM json_each(CASE WHEN NEW.contact_methods = 'null' THEN '[]' ELSE NEW.contact_methods END) UNION ALL ${append('email')} UNION ALL ${append('phone')}
    UNION ALL SELECT item FROM (${extras})
  )) WHERE id = NEW.id;
  UPDATE contacts SET email = (SELECT json_extract(value, '$.value') FROM json_each(contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1),
    phone = (SELECT json_extract(value, '$.value') FROM json_each(contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1) WHERE id = NEW.id AND contact_methods != '[]';
END;
CREATE TRIGGER IF NOT EXISTS contact_methods_primary_update AFTER UPDATE OF email, phone ON contacts
WHEN NEW.contact_methods IS OLD.contact_methods AND (NEW.email IS NOT OLD.email OR NEW.phone IS NOT OLD.phone)
BEGIN
  UPDATE contacts SET contact_methods = (SELECT COALESCE(json_group_array(json(item)), '[]') FROM (
    SELECT CASE ${update('email')} ${update('phone')} ELSE value END AS item FROM json_each(NEW.contact_methods)
    WHERE NOT (json_extract(value, '$.preferred') = 1 AND ((json_extract(value, '$.kind') = 'email' AND (NEW.email IS NULL OR trim(NEW.email) = ''))
      OR (json_extract(value, '$.kind') = 'phone' AND (NEW.phone IS NULL OR trim(NEW.phone) = ''))))
    UNION ALL ${append('email')} UNION ALL ${append('phone')}
  )) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS contact_methods_scalar_update AFTER UPDATE OF contact_methods ON contacts WHEN NEW.contact_methods IS NOT OLD.contact_methods
BEGIN
  UPDATE contacts SET email = (SELECT json_extract(value, '$.value') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND json_extract(value, '$.preferred') = 1),
    phone = (SELECT json_extract(value, '$.value') FROM json_each(NEW.contact_methods) WHERE json_extract(value, '$.kind') = 'phone' AND json_extract(value, '$.preferred') = 1) WHERE id = NEW.id;
END;
`;
}
