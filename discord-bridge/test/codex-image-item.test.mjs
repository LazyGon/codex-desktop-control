import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexImageFilesFromItem,
  codexImagePathAttachmentName,
  hasCodexImageContent,
} from '../src/codex-image-item.mjs';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Codex MCP image result becomes a stable Discord attachment descriptor', () => {
  const item = {
    type: 'mcpToolCall',
    id: 'exec/image:1',
    arguments: { sample: { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG } },
    result: {
      content: [{ type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG }],
    },
  };

  assert.equal(hasCodexImageContent(item), true);
  const result = codexImageFilesFromItem(item);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'codex-image-exec-image-1-1.png');
  assert.equal(result.files[0].mimeType, 'image/png');
  assert.equal(result.files[0].size, Buffer.from(ONE_PIXEL_PNG, 'base64').length);
  assert.equal(result.files[0].sha256.length, 64);
  assert.deepEqual(result.files[0].buffer, Buffer.from(ONE_PIXEL_PNG, 'base64'));
});

test('Codex image extraction accepts data URLs but rejects invalid and oversized images', () => {
  const item = {
    type: 'dynamicToolCall',
    id: 'tool-2',
    output: {
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
        { type: 'image', mimeType: 'image/tiff', data: ONE_PIXEL_PNG },
        { type: 'image', mimeType: 'image/jpeg', data: 'not-base64!' },
      ],
    },
  };

  const result = codexImageFilesFromItem(item, { maximumBytes: 32 });
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /上限/);
  assert.match(result.skipped[1].reason, /base64/);
});

test('imageView paths are recognized without treating arbitrary tool arguments as image output', () => {
  assert.equal(hasCodexImageContent({ type: 'imageView', id: 'view-1', path: 'C:\\work\\image.png' }), true);
  assert.equal(
    codexImagePathAttachmentName('exec:日本語/1', 'C:\\work\\日本語の画像.PNG'),
    'codex-image-exec-1-path.png',
  );
  assert.equal(hasCodexImageContent({
    type: 'mcpToolCall',
    id: 'tool-3',
    arguments: { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG },
    result: { content: [{ type: 'text', text: 'done' }] },
  }), false);
});
