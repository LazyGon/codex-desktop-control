import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileBrowserPayload,
  linkedFilePickerPayload,
  linkedFilesComponents,
} from '../src/discord-file-ui.mjs';

const json = (value) => JSON.parse(JSON.stringify(value));

test('assistant cards expose one stable linked-file button only when links exist', () => {
  assert.deepEqual(linkedFilesComponents(0), []);
  const rows = json(linkedFilesComponents(3));
  assert.equal(rows[0].components[0].custom_id, 'cx:files:linked');
  assert.equal(rows[0].components[0].label, 'Linked files (3)');
});

test('file selectors use native Discord emojis for folders, files, and locked entries', () => {
  const browser = json(fileBrowserPayload({
    key: 'icons',
    threadId: 'thread-1',
    relativeDirectory: '',
    page: 0,
    entries: [
      { name: 'folder', kind: 'directory', navigable: true, lockedReason: null },
      { name: 'report.txt', kind: 'file', size: 12, lockedReason: null },
      { name: '.env', kind: 'file', size: 12, lockedReason: 'secret' },
    ],
  }));
  const browserOptions = browser.components[0].components[0].options;
  assert.deepEqual(browserOptions.map((option) => option.label), ['folder', 'report.txt', '.env']);
  assert.deepEqual(browserOptions.map((option) => option.emoji.name), ['🗂️', '📄', '🔒']);

  const linked = json(linkedFilePickerPayload({
    key: 'linked-icons',
    threadId: 'thread-1',
    page: 0,
    items: [
      { reference: { label: 'report.txt' }, file: { relativePath: 'report.txt' } },
      { reference: { label: '.env' }, error: 'secret' },
    ],
  }));
  assert.deepEqual(
    linked.components[0].components[0].options.map((option) => option.emoji.name),
    ['📄', '🔒'],
  );
  assert.equal(linked.components[1].components[0].custom_id, 'cx:files:linkednav:linked-icons:download');
  assert.equal(linked.components[1].components[0].label, 'Download all as ZIP (1)');
  assert.equal(linked.components[1].components[0].disabled, false);
  const lockedOnly = json(linkedFilePickerPayload({
    key: 'locked-links',
    threadId: 'thread-1',
    page: 0,
    items: [{ reference: { label: '.env' }, file: null, error: 'secret' }],
  }));
  assert.equal(lockedOnly.components[1].components[0].label, 'Download all as ZIP (0)');
  assert.equal(lockedOnly.components[1].components[0].disabled, true);
});

test('project browser pages entries and exposes navigation controls', () => {
  const entries = Array.from({ length: 27 }, (_, index) => ({
    name: `file-${index}.txt`,
    relativePath: `file-${index}.txt`,
    kind: 'file',
    size: index,
    lockedReason: index === 0 ? 'secret' : null,
  }));
  const payload = json(fileBrowserPayload({
    key: 'browser-key', threadId: 'thread-1', relativeDirectory: '', entries, page: 1,
  }));
  assert.equal(payload.components[0].components[0].custom_id, 'cx:files:browse:browser-key');
  assert.equal(payload.components[0].components[0].options.length, 2);
  assert.equal(payload.components[0].components[0].options[0].value, '25');
  assert.deepEqual(payload.components[1].components.map((component) => component.custom_id), [
    'cx:files:nav:browser-key:up',
    'cx:files:nav:browser-key:prev',
    'cx:files:nav:browser-key:next',
    'cx:files:nav:browser-key:refresh',
    'cx:files:nav:browser-key:close',
  ]);
});

test('linked-file picker paginates more than 25 references', () => {
  const items = Array.from({ length: 26 }, (_, index) => ({
    reference: { label: `file-${index}`, target: `C:\\work\\file-${index}` },
    file: { relativePath: `file-${index}` },
    error: null,
  }));
  const payload = json(linkedFilePickerPayload({ key: 'links', threadId: 'thread-1', items, page: 1 }));
  assert.equal(payload.components[0].components[0].options.length, 1);
  assert.equal(payload.components[0].components[0].options[0].value, '25');
  assert.deepEqual(payload.components[1].components.map((component) => component.custom_id), [
    'cx:files:linkednav:links:download',
    'cx:files:linkednav:links:prev',
    'cx:files:linkednav:links:next',
    'cx:files:linkednav:links:close',
  ]);
});
