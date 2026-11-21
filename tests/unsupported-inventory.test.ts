import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/fixtures.js';
import {
  collectUnsupportedInventory,
  type UnsupportedInventory,
} from '../src/scan/unsupported-inventory.js';

describe('Unsupported source inventory', () => {
  it('lists encrypted Antigravity payloads, Trae databases and memory-only data without reading content', async () => {
    const home = await tempDir('aitimeline-inventory-');
    const ide = path.join(home, '.gemini/antigravity-ide');
    await mkdir(path.join(ide, 'conversations'), { recursive: true });
    await mkdir(path.join(ide, 'implicit'), { recursive: true });
    await writeFile(path.join(ide, 'conversations/a.pb'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    await writeFile(path.join(ide, 'conversations/b.pb'), Buffer.from([0x01, 0x02, 0x03]));
    await writeFile(path.join(ide, 'implicit/c.pb'), Buffer.from([0xaa, 0xbb]));
    await writeFile(path.join(ide, 'user_settings.pb'), Buffer.from([0xcc]));

    const traeDb = path.join(
      home,
      'Library/Application Support/Trae CN/ModularData/ai-agent/database.db',
    );
    await mkdir(path.dirname(traeDb), { recursive: true });
    await writeFile(traeDb, Buffer.from([0x4b, 0xc3, 0x98, 0xbe, 0x02, 0xe2, 0x8e, 0xe3]));

    const memory = path.join(home, '.codebuddy/memery/notes.md');
    await mkdir(path.dirname(memory), { recursive: true });
    await writeFile(memory, '# Memory\n');

    const result = await collectUnsupportedInventory({
      agentIds: ['antigravity', 'trae', 'codebuddy'],
      rootsByAgent: { antigravity: [ide] },
      home,
      platform: 'darwin',
    });
    expect(result?.path).toBe('reports/unsupported-inventory.json');
    const inventory = result!.content as UnsupportedInventory;
    expect(inventory.format).toBe('aitimeline-unsupported-inventory');
    expect(inventory.summary.agent_ids).toEqual(['antigravity', 'codebuddy', 'trae']);

    const conversations = inventory.entries.find(
      (entry) => entry.kind === 'encrypted_conversation' && entry.path.endsWith('/conversations'),
    );
    expect(conversations?.file_count).toBe(2);
    expect(conversations?.size_bytes).toBe(7);
    expect(conversations?.sample_files).toHaveLength(2);
    const implicit = inventory.entries.find((entry) => entry.path.endsWith('/implicit'));
    expect(implicit?.file_count).toBe(1);
    expect(inventory.entries.some((entry) => entry.path.endsWith('user_settings.pb'))).toBe(true);

    const trae = inventory.entries.find((entry) => entry.kind === 'encrypted_database');
    expect(trae?.path).toContain('Trae CN/ModularData/ai-agent/database.db');
    expect(trae?.reason).toContain('not a plaintext SQLite header');
    expect(trae?.size_bytes).toBe(8);

    const codeBuddy = inventory.entries.find((entry) => entry.kind === 'memory_only');
    expect(codeBuddy?.file_count).toBe(1);
    expect(codeBuddy?.path).toBe('~/.codebuddy/memery');

    // Paths are home-masked; unsupported payloads keep their opaque bytes.
    expect(inventory.entries.every((entry) => entry.path.startsWith('~'))).toBe(true);
  });

  it('skips agents that were not selected', async () => {
    const home = await tempDir('aitimeline-inventory-none-');
    const result = await collectUnsupportedInventory({
      agentIds: ['codex'],
      home,
      platform: 'darwin',
    });
    expect(result).toBeUndefined();
  });
});
