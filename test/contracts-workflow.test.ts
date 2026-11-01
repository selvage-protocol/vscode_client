import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const name = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name;
const native = name !== 'selvage';
const file = resolve(root, '.github/workflows', native ? 'contracts.yml' : 'ci.yml');
const workflow = readFileSync(file, 'utf8');

function value(step: string, key: string): string | undefined {
  return step.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
}

test('contract jobs pin checker code separately from current canonical specification data', () => {
  const checkouts = workflow.split(/\n(?=      - )/)
    .filter(step => value(step, 'repository') === 'selvage-protocol/specification');
  assert.equal(checkouts.length, 2, 'checker execution and canonical data need separate checkouts');
  const checker = checkouts.find(step => value(step, 'path') === 'contract_checker');
  const canonical = checkouts.find(step => value(step, 'path') === `${native ? 'workspace/' : ''}specification`);
  assert.ok(checker, 'missing immutable checker checkout');
  assert.ok(canonical, 'missing current canonical specification checkout');
  assert.match(value(checker, 'ref') ?? '', /^[0-9a-f]{40}$/);
  assert.equal(value(canonical, 'ref'), 'main');
  for (const step of checkouts) assert.equal(value(step, 'persist-credentials'), 'false');
  assert.ok(workflow.includes('python3 contract_checker/scripts/check-workspace.py'));
  assert.ok(workflow.includes('--revision specification=HEAD'));
  assert.ok(!workflow.includes('python3 workspace/specification/scripts/check-workspace.py'));
  assert.ok(!workflow.includes('python3 specification/scripts/check-workspace.py'));
});
