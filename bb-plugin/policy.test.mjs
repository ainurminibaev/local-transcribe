import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from './policy.ts';
const servers = [
  { hostId: 'mac-id', name: 'MacBook', platform: 'Darwin', device: 'mps', ready: true },
  { hostId: 'tru-id', name: 'Tru', platform: 'Linux', device: 'cpu', ready: true },
  { hostId: 'gpu-id', name: 'GPU', platform: 'Linux', device: 'cuda', ready: true },
];
test('caller decides fallback order and self means caller host', () => {
  assert.deepEqual(candidates(servers, 'mac', ['self','gpu-id'], 'tru-id'), ['mac-id','tru-id','gpu-id']);
});
test('empty fallback never adds another machine', () => {
  assert.deepEqual(candidates(servers, 'mac', [], 'tru-id'), ['mac-id']);
});
test('same host is not attempted twice via aliases', () => {
  assert.deepEqual(candidates(servers, 'mac', ['self','mac-id'], 'mac-id'), ['mac-id']);
});
test('auto picks the best ready GPU service', () => {
  assert.deepEqual(candidates(servers, 'auto', [], 'tru-id'), ['mac-id']);
  const offline = servers.map(s => s.hostId === 'mac-id' ? {...s,ready:false} : s);
  assert.deepEqual(candidates(offline, 'auto', [], 'tru-id'), ['gpu-id']);
});
test('outside a thread self cannot silently mean the BB server', () => {
  assert.deepEqual(candidates(servers, 'mac', ['self'], null), ['mac-id']);
});
test('unknown/cloud service is never invented', () => {
  assert.deepEqual(candidates(servers, 'cloud', [], 'tru-id'), []);
});

test('available continues through remaining ready services exactly once', () => {
  assert.deepEqual(candidates(servers, 'mac', ['self','available'], 'tru-id'), ['mac-id','tru-id','gpu-id']);
  assert.deepEqual(candidates(servers, 'mac', [], 'tru-id'), ['mac-id']);
});
