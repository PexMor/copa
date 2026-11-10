// @vitest-environment node
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import { invalid, valid } from './config-fixtures';

const schema = JSON.parse(readFileSync(new URL('../schema/copa-widget.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); // strict:false for the x-sensitive annotation
const validateSchema = ajv.compile(schema);

describe('runtime validator and JSON Schema agree', () => {
  it('the schema itself is a valid 2020-12 schema', () => {
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  for (const [name, input] of Object.entries(valid)) {
    it(`both accept: ${name}`, () => {
      expect(validateSchema(input), JSON.stringify(validateSchema.errors)).toBe(true);
      expect(validateConfig(input).errors).toEqual([]);
    });
  }

  for (const [name, input] of Object.entries(invalid)) {
    it(`both reject: ${name}`, () => {
      expect(validateSchema(input)).toBe(false);
      expect(validateConfig(input).errors.length).toBeGreaterThan(0);
    });
  }
});
