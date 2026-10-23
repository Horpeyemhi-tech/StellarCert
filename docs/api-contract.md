# API Contract: OpenAPI as the Source of Truth

This document describes how the NestJS backend and the frontend share a single, machine-readable API contract. The contract is the OpenAPI specification generated from the backend DTOs and Swagger decorators. Frontend types are derived from that specification and checked into the repository. CI fails when the checked-in artifacts are stale or when an unapproved breaking change is introduced.

---

## 1. Ownership

| Artifact | Path | Owner | Generated? |
| --- | --- | --- | --- |
| OpenAPI specification | `contract/openapi.json` | Backend team | Yes (from NestJS) |
| Frontend types | `contract/generated/api-types.ts` | Frontend team | Yes (from OpenAPI) |
| Contract tests | `test/contract/**/*.contract.ts` | Platform team | No (hand-maintained) |

Rules:
- The OpenAPI specification is the only source of truth for request/response shapes.
- Frontend code must import types from `contract/generated/api-types.ts`. Hand-maintained duplicates of request/response shapes are not allowed.
- Domain-level domain models (e.g. UI view models, form state) may exist but must derive from or extend the generated types.
- Changes to the contract are reviewed by both the backend and frontend owners.

---

## 2. Reproducible Generation

All commands are run from the repository root and require the development dependencies installed (`pnpm install`, `npm install`, or `yarn install`).

The contract is generated in two steps:

1. **Extract the OpenAPI specification from the NestJS app.** The backend exposes a script that bootstraps the application in a test context, builds the Swagger document, and writes it to `contract/openapi.json`.

   ```bash
   npm run contract:extract
   # equivalent: nest json-script scripts/contract/extract-openapi.ts
   ```

   The script must be deterministic: stable key ordering, no timestamps, no environment-specific values. The generated file is committed.

2. **Generate frontend types from the specification.** Use `openapi-typescript` to produce `contract/generated/api-types.ts`.

   ```bash
   npm run contract:generate
   # equivalent: openapi-typescript --input contract/openapi.json --output contract/generated/api-types.ts
   ```

Both steps are combined into a single entry point used by developers and CI:

```bash
npm run contract:generate
```

The generated files are committed. The command is idempotent: running it twice produces byte-identical output.

### Verifying the contract is fresh

```bash
npm run contract:check
```

This regenerates the contract into a temporary directory and fails if it differs from the checked-in artifacts. It is the same command run in CI.

---

## 3. CI Enforcement

The contract job runs on every pull request and on the main branch.

1. **Staleness check.** `contract:check` regenerates the specification and types and fails with a diff if committed artifacts are out of date. Developers fix this by running `contract:generate` and committing the result.

2. **Breaking-change detection.** `oasdiff compare contract/openapi.json contract/openapi.json --base-ref <base-branch> --fail-on-incompatible` compares the PR branch against the base branch. It fails when a removed endpoint, a removed required request field, a changed response type, or a new required response field is introduced.

3. **Approved breaking changes.** A breaking change is allowed only when the PR includes a marker file at `contract/approved-breaking-changes/<release>.md` containing the reason, the affected endpoints, and the migration notes. The CI job checks for this file when `oasdiff` fails and only then passes. The file is reviewed by both backend and frontend owners.

The CI job fails if any of the following is true:
- `contract/openapi.json` or `contract/generated/api-types.ts` is stale.
- An incompatible change is detected and no approval file is present.
- A contract test fails.

---

## 4. Contract Tests

Contract tests validate responses against the OpenAPI specification using `jest`/`supertest` with an OpenAPI validator. They live in `test/contract/` and are grouped by concern. Each test asserts the status code and the response body shape against the specification.

### 4.1 Success and error envelopes

Every error response follows the shared envelope defined in the specification as `ErrorEnvelope`:

```ts
interface ErrorEnvelope {
  statusCode: number;
  message: string;
  error?: string;
  details?: Record<string, unknown>;
}
```

Tests cover:
- `200` success for a representative GET and POST endpoint.
- `400` validation error with `details` populated.
- `401` unauthenticated and `403` forbidden errors.
- `404` not-found and `500` Internal error envelopes.

### 4.2 Authentication

Tests cover:
- Requests without a bearer token return `401` with the error envelope.
- Requests with an expired or malformed token return `401`.
- Requests with insufficient scope return `403`.
- The `Authorization: Bearer <token>` security scheme is declared in the specification and applied to protected operations.

### 4.3 Pagination

List endpoints return a page object defined in the specification as `PaginatedResponse<T>`:

```ts
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}
```

Tests cover:
- Default pagination returns the expected shape.
- Explicit `page` and `pageSize` query parameters are honoured and validated (`400` for out-of-range values).
- Empty result sets return `items: []`, `total: 0`, `hasNext: false`.

### 4.4 File transfer (multipart and blob)

Tests cover:
- Multipart upload endpoint accepts `multipart/form-data` with a file field and metadata fields, and returns the documented metadata response.
- Upload with a missing file or unsupported content type returns `400` with the error envelope.
- Download endpoint returns the documented content type and `Content-Disposition` headers.
- Download of a missing resource returns `404` with the error envelope.

---

## 5. Update Workflow

When a backend endpoint changes:

1. Update the NestJS DTOs and Swagger decorators.
2. Run `npm run contract:generate`.
3. Commit `contract/openapi.json` and `contract/generated/api-types.ts` alongside the backend change.
4. Update consumers in the frontend to use the new types. The compiler identifies all affected call sites.
5. If the change is breaking, add `contract/approved-breaking-changes/<release>.md` with the required details and obtain review from both teams.
6. Open the PR; the contract CI job validates staleness, compatibility, and contract tests.

When a frontend consumer needs a shape that is not in the contract, the backend must expose it first; the frontend must not hand-maintain a duplicate type.

---

## 6. What Not to Do in the Frontend

- Do not declare interfaces that duplicate OpenAPI schemas. Instead import from `contract/generated/api-types.ts`.
- Do not cast responses to `any` to avoid compiler errors caused by drift; fix the contract instead.
- Do not edit generated files by hand; changes are overwritten by the generator.
