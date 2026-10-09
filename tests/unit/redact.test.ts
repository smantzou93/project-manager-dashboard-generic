import { describe, expect, it } from 'vitest';

import { redact } from '../../packages/logger/src/redact';

/**
 * Redaction is security-relevant: this repository is public, and log lines get
 * pasted into issues. These assert the cases that would actually leak.
 */
describe('redact', () => {
  it('replaces anything key-shaped, at any depth', () => {
    const out = redact({
      password: 'hunter2',
      nested: { api_key: 'abc', apiKey: 'def', fine: 'kept' },
      deep: [{ authorization: 'Basic xyz' }],
    }) as Record<string, any>;

    expect(out.password).toBe('[redacted]');
    expect(out.nested.api_key).toBe('[redacted]');
    expect(out.nested.apiKey).toBe('[redacted]');
    expect(out.nested.fine).toBe('kept');
    expect(out.deep[0].authorization).toBe('[redacted]');
  });

  it('strips a password out of a connection string in free text', () => {
    // The common accident: a DSN inside an error message rather than a field.
    const out = redact('could not connect to postgres://pmdash:s3cret@localhost/db');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('[redacted]');
    // Still readable enough to debug with.
    expect(out).toContain('localhost/db');
  });

  it('strips bearer tokens from free text', () => {
    const out = redact('upstream said 401 for Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('keeps an Error readable without carrying a stack into the record', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(out).not.toHaveProperty('stack');
  });

  it('redacts inside an error message too', () => {
    const out = redact(new Error('postgres://u:p@h/db refused')) as Record<string, string>;
    expect(out.message).not.toContain(':p@');
  });

  it('does not hang on a cyclic object', () => {
    // A logger that throws or hangs takes down the request it was describing.
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ count: 3, ok: true, name: 'RIVER', when: null })).toEqual({
      count: 3,
      ok: true,
      name: 'RIVER',
      when: null,
    });
  });
});
