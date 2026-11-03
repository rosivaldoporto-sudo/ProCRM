import { describe, expect, it } from 'vitest';
import { mediaResponseHeaders } from './media-response';

describe('mediaResponseHeaders', () => {
  it('keeps renderable media inline', () => {
    for (const type of [
      'image/jpeg',
      'audio/ogg; codecs=opus',
      'video/mp4',
      'application/pdf',
    ]) {
      const headers = mediaResponseHeaders(type);
      expect(headers['Content-Type']).toBe(type);
      expect(headers['Content-Disposition']).toBe('inline');
    }
  });

  it('forces active content to download as opaque bytes', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'IMAGE/SVG+XML; charset=utf-8',
      'application/xhtml+xml',
      'text/javascript',
      '',
      null,
      undefined,
    ]) {
      const headers = mediaResponseHeaders(type);
      expect(headers['Content-Type']).toBe('application/octet-stream');
      expect(headers['Content-Disposition']).toBe('attachment');
    }
  });

  it('never allows a shared cache to keep the file', () => {
    const headers = mediaResponseHeaders('image/png');
    expect(headers['Cache-Control']).toMatch(/^private/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
