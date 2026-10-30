import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** Starts one Postgres for the whole run, unless TEST_DATABASE_URL points at an existing server (CI). */
export async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }
  project.provide('pgAdminUrl', url);
}

export async function teardown() {
  await container?.stop();
}
