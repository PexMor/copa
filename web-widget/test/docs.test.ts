// @vitest-environment node
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const schema = JSON.parse(read('../schema/copa-widget.schema.json'));
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Fenced blocks tagged ```json copa-widget.json are complete documents. */
function documentedConfigs(md: string): unknown[] {
  const re = /```json copa-widget\.json\n([\s\S]*?)```/g;
  return [...md.matchAll(re)].map((m) => JSON.parse(m[1]));
}

describe('docs/WIDGET.md', () => {
  const docs = documentedConfigs(read('../../docs/WIDGET.md'));

  it('contains at least one complete example', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  it('every documented configuration validates (runtime validator and JSON Schema)', () => {
    for (const d of docs) {
      expect(validateSchema(d), JSON.stringify(validateSchema.errors)).toBe(true);
      const r = validateConfig(d);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it('every auth snippet in the docs is accepted when wrapped in an endpoint', () => {
    const md = read('../../docs/WIDGET.md');
    const snippets = [...md.matchAll(/```json\n(\{\s*"method"[\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    expect(snippets.length).toBeGreaterThanOrEqual(3);
    for (const auth of snippets) {
      const r = validateConfig({ version: 1, endpoints: [{ id: 'a', url: 'https://c.example.com', auth }] });
      expect(r.errors, JSON.stringify(auth)).toEqual([]);
    }
  });
});
