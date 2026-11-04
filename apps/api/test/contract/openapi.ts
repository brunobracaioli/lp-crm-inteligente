import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * OpenAPI 3.1 response validation for contract tests. The whole document is registered as one
 * JSON Schema resource, so every `$ref` (`#/components/...`) resolves natively and a schema is
 * always checked with the exact definition the front-end team reads.
 */

const CONTRACT_URL = new URL('../../../../contracts/openapi.v1.yaml', import.meta.url);
const CONTRACT_ID = 'https://contracts.test/openapi.v1.yaml';
const REF_PREFIX = '#/components/';

type Json = Record<string, unknown>;

interface HeaderObject {
  readonly required?: boolean;
  readonly schema?: unknown;
}

interface ResponseObject {
  readonly description?: string;
  readonly headers?: Readonly<Record<string, HeaderObject>>;
  readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function loadContract(): Json {
  const document: unknown = parse(readFileSync(CONTRACT_URL, 'utf8'));
  if (!isRecord(document)) throw new Error('OpenAPI document is not an object');
  return document;
}

/** Follows `{ $ref: '#/components/...' }` chains inside the contract. */
// The traversal is untyped JSON; each caller states the shape it expects from this contract node.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function resolveRef<T>(document: Json, node: unknown): T {
  let current = node;
  while (isRecord(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    current = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (value, segment) => (isRecord(value) ? value[segment] : undefined),
        document,
      );
  }
  return current as T;
}

/** Header values arrive as strings; coerce them to what the declared schema expects. */
function coerceHeader(value: string, schema: unknown): unknown {
  const type = isRecord(schema) ? schema.type : undefined;
  return type === 'integer' || type === 'number' ? Number(value) : value;
}

export function createContract() {
  const document = loadContract();
  // Warnings (unknown keyword/format) become errors so a contract change cannot be silently ignored.
  const throwingLogger = {
    log: (): void => undefined,
    warn: (...args: unknown[]): never => {
      throw new Error(`ajv warning: ${args.map(String).join(' ')}`);
    },
    error: (...args: unknown[]): never => {
      throw new Error(`ajv error: ${args.map(String).join(' ')}`);
    },
  };
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: false, // OpenAPI vocabulary (`x-*`, `example`, …) is not JSON Schema
    strictTypes: false,
    strictRequired: false,
    logger: throwingLogger,
  });
  addFormats.default(ajv);
  ajv.addSchema({ ...document, $id: CONTRACT_ID });

  const compiled = new Map<string, ValidateFunction>();
  const validatorFor = (schemaNode: unknown): ValidateFunction => {
    const ref = isRecord(schemaNode) ? schemaNode.$ref : undefined;
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) {
      throw new Error('contract schemas are expected to be $ref to #/components/schemas');
    }
    const cached = compiled.get(ref);
    if (cached !== undefined) return cached;
    const validate = ajv.getSchema(`${CONTRACT_ID}${ref}`);
    if (validate === undefined) throw new Error(`schema ${ref} not found`);
    compiled.set(ref, validate);
    return validate;
  };

  const operation = (path: string, method: string): Json => {
    const paths = document.paths;
    const pathItem = isRecord(paths) ? paths[path] : undefined;
    const op = isRecord(pathItem) ? pathItem[method] : undefined;
    if (!isRecord(op)) throw new Error(`operation ${method.toUpperCase()} ${path} not in contract`);
    return op;
  };

  const declaredResponses = (path: string, method: string): Json => {
    const responses = operation(path, method).responses;
    if (!isRecord(responses)) throw new Error('operation has no responses');
    return responses;
  };

  return {
    /** Status codes the contract declares for the operation. */
    declaredStatuses(path: string, method: string): readonly number[] {
      return Object.keys(declaredResponses(path, method)).map(Number);
    },

    /** Validates a request body against the operation's request schema (fixture sanity check). */
    requestProblems(path: string, method: string, body: unknown): readonly string[] {
      const requestBody = resolveRef<{
        content?: Record<string, { schema?: unknown }>;
      }>(document, operation(path, method).requestBody);
      const schema = requestBody.content?.['application/json']?.schema;
      const validate = validatorFor(schema);
      return validate(body)
        ? []
        : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`.trim());
    },

    /**
     * Everything wrong with a real response, as plain strings (empty = conforms): undeclared
     * status, wrong media type, body not matching the schema, declared header missing or invalid.
     * `bodyText` is the raw body, parsed here according to the declared media type.
     */
    responseProblems(
      path: string,
      method: string,
      response: { status: number; headers: Headers; bodyText: string },
    ): readonly string[] {
      const responses = declaredResponses(path, method);
      const node = responses[String(response.status)];
      if (node === undefined) {
        return [`status ${response.status} is not declared for ${method.toUpperCase()} ${path}`];
      }
      const declared = resolveRef<ResponseObject>(document, node);
      const problems: string[] = [];

      const mediaType = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
      const content = declared.content?.[mediaType];
      if (content === undefined) {
        problems.push(
          `media type "${mediaType}" is not declared for status ${response.status} ` +
            `(declared: ${Object.keys(declared.content ?? {}).join(', ') || 'none'})`,
        );
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.bodyText);
        } catch {
          problems.push('body is not valid JSON');
        }
        if (parsed !== undefined) {
          const validate = validatorFor(content.schema);
          if (!validate(parsed)) {
            problems.push(
              ...(validate.errors ?? []).map((e) => `body${e.instancePath} ${e.message ?? ''}`),
            );
          }
        }
      }

      for (const [name, headerNode] of Object.entries(declared.headers ?? {})) {
        const header = resolveRef<HeaderObject>(document, headerNode);
        const value = response.headers.get(name);
        if (value === null) {
          // The contract documents these headers on the response; a client may rely on them.
          problems.push(`declared header ${name} is missing`);
          continue;
        }
        const validate = ajv.compile(resolveRef<Json>(document, header.schema) as object);
        if (!validate(coerceHeader(value, header.schema))) {
          problems.push(`header ${name}="${value}" violates its schema`);
        }
      }
      return problems;
    },

    /** Machine codes named in the response description (e.g. "origin_not_allowed | …"). */
    documentedCodes(path: string, method: string, status: number): readonly string[] {
      const declared = resolveRef<ResponseObject>(
        document,
        declaredResponses(path, method)[String(status)],
      );
      return declared.description?.match(/[a-z]+(?:_[a-z]+)+/g) ?? [];
    },
  };
}

export type Contract = ReturnType<typeof createContract>;
