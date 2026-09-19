import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJsonText, parseStructured } from '../../src/llm/json.js';
import { LLMEvaluationSchema } from '../../src/domain/evaluation.schema.js';

const schema = z.object({ a: z.number() });

describe('JSON extraction from model output', () => {
  it('reads a bare object', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown code fences', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips reasoning blocks emitted before the answer', () => {
    expect(extractJsonText('<think>Let me consider...</think>{"a":1}')).toBe('{"a":1}');
  });

  it('ignores prose surrounding the object', () => {
    expect(extractJsonText('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('handles braces inside strings', () => {
    const text = '{"a":"has } a brace"}';
    expect(extractJsonText(text)).toBe(text);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"a":"say \\"hi\\""}';
    expect(extractJsonText(text)).toBe(text);
  });

  it('handles nested objects', () => {
    const text = '{"a":{"b":{"c":1}}}';
    expect(extractJsonText(text)).toBe(text);
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonText('I cannot help with that.')).toBeNull();
  });

  it('returns null for an unterminated object', () => {
    expect(extractJsonText('{"a":1')).toBeNull();
  });
});

describe('structured parsing', () => {
  it('reports the failure stage for prose', () => {
    const result = parseStructured('no json here', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('extract');
  });

  it('reports the failure stage for invalid JSON syntax', () => {
    const result = parseStructured('{"a": }', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('json');
  });

  it('reports the failure stage for a schema mismatch', () => {
    const result = parseStructured('{"a":"not a number"}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('schema');
  });

  it('rejects an evaluation with an out-of-range score', () => {
    const result = parseStructured(
      '{"score":150,"confidence":0.9,"recommendation":"APPLY"}',
      LLMEvaluationSchema,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an evaluation with an invalid recommendation label', () => {
    const result = parseStructured(
      '{"score":90,"confidence":0.9,"recommendation":"MAYBE"}',
      LLMEvaluationSchema,
    );
    expect(result.ok).toBe(false);
  });

  it('fills optional fields with safe defaults', () => {
    const result = parseStructured(
      '{"score":90,"confidence":0.9,"recommendation":"HIGH_PRIORITY"}',
      LLMEvaluationSchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matchingSkills).toEqual([]);
      expect(result.value.needsCloud).toBe(false);
      expect(result.value.uncertainties.conflicting).toBe(false);
    }
  });
});
