import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreTypeRegistry, createTypeRegistry } from '../../src/core/types.js';

test('core registry contains the expected types', () => {
  const r = createCoreTypeRegistry();
  for (const id of ['Float', 'Int', 'Bool', 'Vec2', 'Vec3', 'Vec4', 'Quaternion', 'Color']) {
    assert.ok(r.has(id), `missing type ${id}`);
  }
});

test('same-type connections are always compatible', () => {
  const r = createCoreTypeRegistry();
  for (const t of r.list()) {
    assert.ok(r.isCompatible(t.id, t.id), `${t.id} should connect to itself`);
  }
});

test('Color and Vec4 are mutually compatible', () => {
  const r = createCoreTypeRegistry();
  assert.ok(r.isCompatible('Color', 'Vec4'));
  assert.ok(r.isCompatible('Vec4', 'Color'));
});

test('Float broadcasts to Vec2/3/4 but not the reverse', () => {
  const r = createCoreTypeRegistry();
  assert.ok(r.isCompatible('Float', 'Vec3'));
  assert.ok(!r.isCompatible('Vec3', 'Float'));
});

test('Int promotes to Float but not the reverse', () => {
  const r = createCoreTypeRegistry();
  assert.ok(r.isCompatible('Int', 'Float'));
  assert.ok(!r.isCompatible('Float', 'Int'));
});

test('unrelated types are not compatible', () => {
  const r = createCoreTypeRegistry();
  assert.ok(!r.isCompatible('Color', 'Float'));
  assert.ok(!r.isCompatible('Bool', 'Vec3'));
});

test('registering the same type twice throws', () => {
  const r = createTypeRegistry();
  r.register({ id: 'Foo', color: '#000', description: '' });
  assert.throws(() => r.register({ id: 'Foo', color: '#fff', description: '' }), /already/);
});
