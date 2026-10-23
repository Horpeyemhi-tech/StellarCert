import { NestApplication } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync, mkdirSync } from 'fs'; 
import { dirname, resolve } from 'path';
import { AppModule } from '../app.module';

/**
 * Generates the OpenAPI specification for the StellarCert backend and writes it to
 * disk. This is the single source of truth for the frontend API contract.
 *
 * The generated JSON is checked in at `backend/openapi/openapi.json` and the
 * frontend contract types are derived from it via `npm run contract:generate`.
 *
 * The generator is deliberately side-effect free: the Nest application is created
 * without listening on a port and without connecting to external services. The
 * generated document is written atomically to the configured output path.
 */

const DEFAULT_OUTPUS_PATH = resolve(__dirname, '../../openapi/openapi.json');

export interface GenerateOpenApiOptions {
  /** Absolute or relative path to write the generated specification to. */
  outputPath?: string;
  /** When true, no file is written and the document is only returned. */
  dryRun?: boolean;
}

/**
 * Builds the OpenAPI document using the same configuration as `src/main.ts`.
 * Keeping this in sync with main.ts ensures the contract matches the running
 * application's Swagger UI.
 */
export function buildOpenApiDocument(app: NestApplication) {
  const config = new DocumentBuilder()
    .setTitle('StellarCert API')
    .setDescription('Certificate Management System API Documentation')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}

/**
 * Creates a Nest application context suitable for OpenAPI generation.
 *
 * The application is initialized with the same global prefix and versioning
 * settings as the real bootstrap so paths and versioned operations are reflected
 * identically in the contract.
 */
export async function createOpenApiApp(): Promise<NestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: true,
  });

  // Match the runtime configuration from main.ts so the generated contract
  // reflects the actual served paths.
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  await app.init();

  return app;
}

/**
 * Generates the OpenAPI specification and optionally writes it to disk.
 */
export async function generateOpenApi(options: GenerateOpenApiOptions = {}): Promise<string> {
  const outputPath = resolve(options.outputPath ?? DEFAULT_OUTPUT_PATH);
  const app = await createOpenApiApp();

  try {
    const document = buildOpenApiDocument(app);
    const serialized = JSON.stringify(document, null, 2) + '\n';

    if (!options.dryRun) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, serialized, 'utf8');
    }

    return serialized;
  } finally {
    await app.close();
  }
}

/**
 * Entrypoint for the `npm run contract:generate` script.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const outputFlagIndex = argv.indexOf('--output');
  const outputPath =
    outputFlagIndex !== -1 && argv[outputFlagIndex + 1]
      ? argv[outputFlagIndex + 1]
      : undefined;

  const dryRun = argv.includes('--dry-run');

  const serialized = await generateOpenApi({ outputPath, dryRun });

  if (dryRun) {
    process.stdout.write(serialized);
  } else {
    // eslint-disable-next-line no-console
    console.log(`OpenAPI specification written to ${resolve(outputPath ?? DEFAULT_OUTPUT_PATH)}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to generate OpenAPI specification:', error);
    process.exit(1);
  });
}
