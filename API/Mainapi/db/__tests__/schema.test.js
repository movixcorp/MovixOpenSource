const test = require('node:test');
const assert = require('node:assert/strict');

const EXPECTED_TABLES = [
  'access_keys', 'account_links', 'admins', 'banned_users',
  'comments', 'comment_replies', 'comment_reactions', 'notifications',
  'likes', 'reports', 'user_notification_preferences', 'push_subscriptions',
  'content_notification_trackers', 'content_notification_events',
  'shared_lists', 'user_sessions', 'films', 'series', 'link_submissions',
  'download_links_history', 'help_feedback', 'wishboard_requests',
  'wishboard_votes', 'wishboard_notes', 'wishboard_status_history',
  'wrapped_viewing_data', 'wrapped_pages_data', 'oauth_clients',
  'oauth_app_stats', 'oauth_vip_grants', 'oauth_authorization_codes',
  'oauth_authorization_requests', 'oauth_access_tokens', 'clone_links',
  'vip_derivation_counters', 'vip_invoices', 'vip_invoice_events',
].sort();

test('manifest contains every MySQL table referenced by MainAPI', () => {
  const { schema } = require('../schema');
  assert.deepEqual(schema.map((table) => table.name).sort(), EXPECTED_TABLES);
});

test('every table renders additive create DDL and unique object names', () => {
  const { schema, renderCreateTable } = require('../schema');
  assert.equal(new Set(schema.map((table) => table.name)).size, schema.length);
  for (const table of schema) {
    const sql = renderCreateTable(table);
    assert.match(sql, /^CREATE TABLE IF NOT EXISTS `[a-z0-9_]+`/);
    assert.doesNotMatch(sql, /(?:^|;)\s*(DROP|TRUNCATE|DELETE|UPDATE|MODIFY|CHANGE|RENAME)\b/i);
    assert.equal(new Set(table.columns.map((column) => column.name)).size, table.columns.length);
    assert.equal(new Set(table.indexes.map((index) => index.name)).size, table.indexes.length);
    assert.equal(new Set(table.foreignKeys.map((foreignKey) => foreignKey.name)).size, table.foreignKeys.length);
  }
});

test('additive renderers produce DDL for manifest column, index, and foreign key', () => {
  const {
    getTable,
    renderAddColumn,
    renderAddIndex,
    renderAddForeignKey,
  } = require('../schema');
  const table = getTable('wishboard_votes');
  const column = table.columns.find((value) => value.name === 'profile_id');
  const index = table.indexes.find((value) => value.name === 'idx_wishboard_votes_request');
  const foreignKey = table.foreignKeys.find((value) => value.name === 'fk_wishboard_votes_request');

  assert.equal(
    renderAddColumn(table, column),
    'ALTER TABLE `wishboard_votes` ADD COLUMN `profile_id` VARCHAR(255) NOT NULL',
  );
  assert.equal(
    renderAddIndex(table, index),
    'ALTER TABLE `wishboard_votes` ADD KEY `idx_wishboard_votes_request` (`request_id`)',
  );
  assert.equal(
    renderAddForeignKey(table, foreignKey),
    'ALTER TABLE `wishboard_votes` ADD CONSTRAINT `fk_wishboard_votes_request` FOREIGN KEY (`request_id`) REFERENCES `wishboard_requests` (`id`) ON DELETE CASCADE',
  );
});

test('manifest table specifications are deeply immutable', () => {
  const { getTable, renderCreateTable } = require('../schema');
  const table = getTable('wishboard_votes');
  const column = table.columns.find((value) => value.name === 'profile_id');
  const index = table.indexes.find((value) => value.name === 'idx_wishboard_votes_request');
  const foreignKey = table.foreignKeys.find((value) => value.name === 'fk_wishboard_votes_request');
  const before = renderCreateTable(table);

  assert.ok(Object.isFrozen(table.primaryKey));
  assert.ok(Object.isFrozen(column));
  assert.ok(Object.isFrozen(column.expected));
  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.columns));
  assert.ok(Object.isFrozen(foreignKey));
  assert.ok(Object.isFrozen(foreignKey.columns));
  assert.ok(Object.isFrozen(foreignKey.referencedColumns));
  assert.throws(() => table.primaryKey.push('profile_id'), TypeError);
  assert.throws(() => index.columns.push('profile_id'), TypeError);
  assert.throws(() => foreignKey.columns.push('profile_id'), TypeError);
  column.name = 'mutated_column';
  column.expected.nullable = true;
  index.name = 'mutated_index';
  foreignKey.referencedTable = 'mutated_table';
  assert.equal(column.name, 'profile_id');
  assert.equal(column.expected.nullable, false);
  assert.equal(index.name, 'idx_wishboard_votes_request');
  assert.equal(foreignKey.referencedTable, 'wishboard_requests');
  assert.equal(renderCreateTable(table), before);
});

test('identifier renderer rejects dynamic SQL identifiers', () => {
  const { quoteIdentifier } = require('../schema');
  assert.equal(quoteIdentifier('wrapped_viewing_data'), '`wrapped_viewing_data`');
  assert.throws(() => quoteIdentifier('films; DROP TABLE films'), /identifiant SQL invalide/i);
});

test('only Wrapped tables carry the sensitive marker', () => {
  const { schema } = require('../schema');
  assert.deepEqual(
    schema.filter((table) => table.wrapped).map((table) => table.name).sort(),
    ['wrapped_pages_data', 'wrapped_viewing_data'],
  );
});

function indexedColumnBudget(column) {
  const definition = column.definition.toLowerCase();
  const bytesPerCharacter = /character set\s+ascii\b/.test(definition) ? 1 : 4;
  const characterType = /^(?:var)?char\((\d+)\)/.exec(column.expected.columnType);
  if (characterType) return Number(characterType[1]) * bytesPerCharacter;
  if (/^enum\b/.test(column.expected.columnType)) return 2;
  if (/^bigint\b/.test(column.expected.columnType)) return 8;
  if (/^(?:int|integer)\b/.test(column.expected.columnType)) return 4;
  if (/^smallint\b/.test(column.expected.columnType)) return 2;
  if (/^(?:tinyint|boolean)\b/.test(column.expected.columnType)) return 1;
  if (/^(?:timestamp|datetime)\b/.test(column.expected.columnType)) return 8;
  throw new Error(`Type indexe non budgete: ${column.name} ${column.expected.columnType}`);
}

test('every manifest primary and secondary index fits the InnoDB 3072-byte key limit', () => {
  const { schema } = require('../schema');
  const violations = [];

  for (const table of schema) {
    const indexes = [
      { name: 'PRIMARY', columns: table.primaryKey },
      ...table.indexes,
    ];
    for (const index of indexes) {
      const budget = index.columns.reduce((total, columnName) => {
        const column = table.columns.find((candidate) => candidate.name === columnName);
        assert.ok(column, `${table.name}.${index.name} references ${columnName}`);
        return total + indexedColumnBudget(column);
      }, 0);
      if (budget > 3072) violations.push(`${table.name}.${index.name}=${budget}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('manifest contains the columns required by current MainAPI callers', () => {
  const { getTable } = require('../schema');
  const contracts = [
    ['user_sessions', 'device', 'text', true, null],
    ['admins', 'role', 'enum', false, 'admin'],
    ['shared_lists', 'name', 'varchar(255)', true, null],
  ];

  for (const [tableName, columnName, columnType, nullable, defaultValue] of contracts) {
    const column = getTable(tableName).columns.find((candidate) => candidate.name === columnName);
    assert.ok(column, `${tableName}.${columnName} is required by an application query`);
    assert.equal(column.expected.columnType.replace(/\s+/g, ''), columnType);
    assert.equal(column.expected.nullable, nullable);
    assert.equal(column.expected.defaultValue, defaultValue);
    if (tableName === 'admins' && columnName === 'role') {
      assert.match(column.definition.replace(/\s+/g, ''), /ENUM\('admin','uploader'\)/i);
    }
  }
});

test('rendered MySQL 8 schema omits nonportable LOB defaults', () => {
  const { schema, renderCreateTable } = require('../schema');
  const ddl = schema.map(renderCreateTable).join('\n');

  assert.doesNotMatch(ddl, /\b(?:TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|BLOB)\s+DEFAULT\s+/i);
  assert.match(
    renderCreateTable(schema.find((table) => table.name === 'oauth_authorization_requests')),
    /`state` TEXT(?:\s+NULL)?[,\n]/,
  );
});
