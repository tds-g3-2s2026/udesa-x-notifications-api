import { readFileSync } from 'node:fs';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// ADR-017: the schemas in contracts/events/ are the contract, so the messages
// the tests send are built from their own `examples` and validated against
// them, with the formats (uuid, email, uri, date-time) switched on.
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

export interface EventEnvelope {
  specversion: string;
  id: string;
  source: string;
  type: string;
  time: string;
  data: Record<string, string>;
}

interface EventSchema {
  examples: EventEnvelope[];
}

const compiled = new Map<string, { example: EventEnvelope; validate: ValidateFunction }>();

function load(type: string) {
  let entry = compiled.get(type);
  if (!entry) {
    const url = new URL(`../../contracts/events/${type}.json`, import.meta.url);
    const schema: EventSchema = JSON.parse(readFileSync(url, 'utf8'));
    entry = { example: schema.examples[0], validate: ajv.compile(schema) };
    compiled.set(type, entry);
  }
  return entry;
}

/**
 * The first example of an event's schema, with `id` replaced when given (the
 * integration tests need a fresh one per run), validated against that schema.
 * A new object on every call, so a test can change it freely.
 */
export function exampleEvent(type: string, id?: string): EventEnvelope {
  const { example, validate } = load(type);
  const event: EventEnvelope = { ...structuredClone(example), ...(id ? { id } : {}) };
  if (!validate(event)) {
    throw new Error(`The ${type} message breaks its schema: ${ajv.errorsText(validate.errors)}`);
  }
  return event;
}
