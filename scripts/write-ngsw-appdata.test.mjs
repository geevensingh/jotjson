import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILD_NUMBER_TOKEN,
  BUILD_SHA_TOKEN,
  substituteNgswAppData,
} from './write-ngsw-appdata.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, '.write-ngsw-appdata-test-work');
let workspaceCounter = 0;

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function withWorkspace(name, callback) {
  const workspace = join(workspaceRoot, `${process.pid}-${workspaceCounter}-${name}`);
  workspaceCounter += 1;
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  try {
    return await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function buildInfoContents({ buildSha = 'abcdef1234567890', buildNumber = '42' } = {}) {
  return (
    'export interface BuildInfo { readonly sha: string; readonly buildNumber: string; }\n' +
    'export const BUILD_INFO: BuildInfo = ' +
    JSON.stringify(
      {
        version: '0.0.0-test',
        sha: buildSha,
        branch: 'test',
        builtAt: '2026-05-13T00:00:00.000Z',
        repoUrl: 'https://github.com/geevensingh/jotjson',
        buildNumber,
      },
      null,
      2,
    ) +
    ';\n'
  );
}

function manifestContents(appData) {
  return JSON.stringify(
    {
      configVersion: 1,
      timestamp: 1234567890,
      appData,
      assetGroups: [],
      dataGroups: [],
      hashTable: {},
    },
    null,
    2,
  );
}

function captureLogger() {
  const messages = [];
  return {
    messages,
    logger: {
      log(message) {
        messages.push(message);
      },
    },
  };
}

test('substituteNgswAppData replaces both appData placeholders', async () => {
  await withWorkspace('happy-path', async (workspace) => {
    const ngswPath = join(workspace, 'ngsw.json');
    const buildInfoPath = join(workspace, 'build-info.ts');
    await writeFile(
      ngswPath,
      manifestContents({ buildSha: BUILD_SHA_TOKEN, buildNumber: BUILD_NUMBER_TOKEN }),
      'utf8',
    );
    await writeFile(
      buildInfoPath,
      buildInfoContents({ buildSha: 'abc123def456', buildNumber: '314' }),
      'utf8',
    );

    const result = await substituteNgswAppData({
      ngswPath,
      buildInfoPath,
      logger: captureLogger().logger,
    });
    const updatedText = await readFile(ngswPath, 'utf8');
    const updatedManifest = JSON.parse(updatedText);

    assert.equal(result.status, 'substituted');
    assert.equal(updatedText.includes(BUILD_SHA_TOKEN), false);
    assert.equal(updatedText.includes(BUILD_NUMBER_TOKEN), false);
    assert.equal(updatedManifest.appData.buildSha, 'abc123def456');
    assert.equal(updatedManifest.appData.buildNumber, '314');
  });
});

test('substituteNgswAppData exits unchanged when placeholders are already absent', async () => {
  await withWorkspace('idempotent', async (workspace) => {
    const ngswPath = join(workspace, 'ngsw.json');
    const buildInfoPath = join(workspace, 'missing-build-info.ts');
    await writeFile(ngswPath, manifestContents({ buildSha: 'already', buildNumber: '7' }), 'utf8');
    const { logger, messages } = captureLogger();

    const result = await substituteNgswAppData({ ngswPath, buildInfoPath, logger });

    assert.deepEqual(result, { status: 'unchanged' });
    assert.equal(
      messages.some((message) => message.includes('no placeholders found')),
      true,
    );
  });
});

test('substituteNgswAppData fails clearly when build-info is missing', async () => {
  await withWorkspace('missing-build-info', async (workspace) => {
    const ngswPath = join(workspace, 'ngsw.json');
    const buildInfoPath = join(workspace, 'build-info.ts');
    await writeFile(
      ngswPath,
      manifestContents({ buildSha: BUILD_SHA_TOKEN, buildNumber: BUILD_NUMBER_TOKEN }),
      'utf8',
    );

    await assert.rejects(
      () => substituteNgswAppData({ ngswPath, buildInfoPath, logger: captureLogger().logger }),
      /build info not found/,
    );
  });
});

test('substituteNgswAppData fails when only one placeholder is present', async () => {
  await withWorkspace('partial-placeholders', async (workspace) => {
    const ngswPath = join(workspace, 'ngsw.json');
    const buildInfoPath = join(workspace, 'build-info.ts');
    await writeFile(
      ngswPath,
      manifestContents({ buildSha: BUILD_SHA_TOKEN, buildNumber: '314' }),
      'utf8',
    );
    await writeFile(buildInfoPath, buildInfoContents(), 'utf8');

    await assert.rejects(
      () => substituteNgswAppData({ ngswPath, buildInfoPath, logger: captureLogger().logger }),
      /must contain both __BUILD_SHA__ and __BUILD_NUMBER__, or neither/,
    );
  });
});
